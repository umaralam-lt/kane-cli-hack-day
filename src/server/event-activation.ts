import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import { maskCode, parseCodexCodes } from "@/lib/codex-codes";
import { mapClaimResponse, type ClaimOutcome } from "@/lib/testmu-claim";
import { CLAIM_OK_CODES } from "@/lib/testmu-provision";
import { PLAN_MESSAGES, type ActivationStepId } from "@/data/activation-steps";
import { memberActor, staffActor, type MemberRow, type Staff } from "./auth";
import { AppError, maskEmail, transaction, withAudit, writeAudit, type Actor } from "./core";
import { rateLimit } from "./ratelimit";

// The event-day activation checklist (/activate), replacing the Kane-driven
// ceremony for participants:
//   1 testmu_signup  a link to TestMu AI + a Done tick
//   2 testmu_plan    a server-side claim of the hack-day plan (the member's own email)
//   3 codex_credits  a personal OpenAI Codex credit code from an organizer-uploaded pool + a Done tick
// All three done → members.activated_at (what metrics and the desk read).
//
// Step 3 opens once the member is on a team and has ticked step 1. It does not
// wait for step 2, so a TestMu AI outage never blocks the Codex credits.

export const STEP_IDS: ActivationStepId[] = ["testmu_signup", "testmu_plan", "codex_credits"];

export type PlanClaim = {
  status: "pending" | "claimed" | "not_registered" | "error";
  http_status: number | null;
  last_error: string | null;
  attempts: number;
  claimed_at: Date | null;
  last_attempt_at: Date | null;
};

export type ActivationView = {
  ticks: Set<ActivationStepId>;
  plan: PlanClaim | null;
  /** The member's own code (full), only ever returned to that member. */
  code: { code: string; assigned_at: Date; extra: Record<string, string> } | null;
  done: boolean;
};

export async function getActivationView(memberId: number): Promise<ActivationView> {
  const [ticks, plan, code] = await Promise.all([
    query<{ step: ActivationStepId }>("select step from activation_ticks where member_id = $1", [memberId]),
    query<PlanClaim>("select status, http_status, last_error, attempts, claimed_at, last_attempt_at from testmu_plan_claims where member_id = $1", [memberId]),
    query<{ code: string; assigned_at: Date; extra: Record<string, string> }>("select code, assigned_at, extra from codex_credit_codes where assigned_member_id = $1 and status = 'assigned'", [memberId]),
  ]);
  const set = new Set(ticks.map((t) => t.step));
  return { ticks: set, plan: plan[0] ?? null, code: code[0] ?? null, done: STEP_IDS.every((s) => set.has(s)) };
}

/** All three ticked → stamp activated_at once. */
async function syncActivated(db: Pick<PoolClient, "query">, memberId: number) {
  await db.query(
    `update members set activated_at = coalesce(activated_at, now())
      where id = $1 and (select count(*) from activation_ticks t where t.member_id = $1) = 3`,
    [memberId],
  );
}

async function requireTeam(member: MemberRow) {
  if (!member.team_id) throw new AppError("CONFLICT", { userMessage: "Join or create a team first (at /team), then activate." });
}

/** Tick or untick step 1 or 3. Step 2 is ticked only by a successful claim; step 3 needs an assigned code. */
export async function setTick(member: MemberRow, step: ActivationStepId, done: boolean) {
  if (step === "testmu_plan") throw new AppError("VALIDATION_FAILED", { userMessage: "Step 2 is ticked when your plan activates." });
  await requireTeam(member);
  return withAudit(memberActor(member), done ? "activation.tick" : "activation.untick", "activation_tick", async (tx) => {
    if (step === "codex_credits" && done) {
      const { rows } = await tx.query("select 1 from codex_credit_codes where assigned_member_id = $1 and status = 'assigned'", [member.id]);
      if (!rows[0]) throw new AppError("CONFLICT", { userMessage: "Get your Codex credit code first." });
    }
    if (done) await tx.query("insert into activation_ticks (member_id, step) values ($1, $2) on conflict do nothing", [member.id, step]);
    else await tx.query("delete from activation_ticks where member_id = $1 and step = $2", [member.id, step]);
    await syncActivated(tx, member.id);
    return { result: { step, done }, resourceId: member.id, payload: { step, done } };
  });
}

// ── Step 2: TestMu AI plan claim ─────────────────────────────────────────────

export const TESTMU_CLAIM_DEFAULT_URL = "https://backend.lambdatest.com/api/trials/hack-day/claim";
const CLAIM_PAGE_URL = "https://kaneclihack.sh/";
const CLAIM_TIMEOUT_MS = 10_000;

const isProduction = () => process.env.VERCEL_ENV === "production" || process.env.HACKOS_ENV === "production";

/**
 * Where the claim goes. Production: TESTMU_TRIAL_CLAIM_URL or the real API.
 * Anywhere else the real API is never called: a stub answers, shaped by
 * TESTMU_CLAIM_STUB (success | not_registered | invalid | error | timeout;
 * default success), unless TESTMU_TRIAL_CLAIM_URL points at some other
 * (mock) host.
 */
export function claimTarget(): { kind: "http"; url: string } | { kind: "stub"; mode: string } {
  const env = process.env.TESTMU_TRIAL_CLAIM_URL?.trim();
  if (isProduction()) return { kind: "http", url: env || TESTMU_CLAIM_DEFAULT_URL };
  if (env && !/lambdatest\.com|testmuai\.com/i.test(env)) return { kind: "http", url: env };
  return { kind: "stub", mode: process.env.TESTMU_CLAIM_STUB?.trim() || "success" };
}

type RawAnswer = { status: number | null; body: unknown; failure?: string };

function stubAnswer(mode: string): RawAnswer {
  switch (mode) {
    case "not_registered":
      // The real API's answer for an email with no TestMu AI account.
      return { status: 200, body: { code: "NON_SIGNEDUP", message: "Claim recorded. Trial will be activated after signup." } };
    case "invalid":
      return { status: 422, body: { code: "INVALID_REQUEST", errors: { email: ["The email must be a valid email address."] } } };
    case "error":
      return { status: 503, body: { code: "UNAVAILABLE" } };
    case "timeout":
      return { status: null, body: undefined, failure: "timeout (stub)" };
    default:
      return { status: 200, body: { status: "success", stub: true } };
  }
}

async function callClaim(email: string): Promise<RawAnswer> {
  const t = claimTarget();
  if (t.kind === "stub") return stubAnswer(t.mode);
  try {
    const res = await fetch(t.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, source: "website", page_url: CLAIM_PAGE_URL }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch (e) {
    const name = (e as Error)?.name;
    return { status: null, body: undefined, failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error" };
  }
}

export type ClaimView = { outcome: ClaimOutcome | "in_progress"; message: string };

/**
 * Claim the hack-day plan for the signed-in member's own email (read from the
 * member row, never from input). Once claimed it never calls again. A failed
 * claim can be retried; attempts are rate-limited per member, and only one
 * runs at a time. Every attempt is audited (status and code, no email).
 */
export async function claimPlan(member: MemberRow): Promise<ClaimView> {
  await requireTeam(member);
  const [row] = await query<{ status: string }>("select status from testmu_plan_claims where member_id = $1", [member.id]);
  if (row?.status === "claimed") return { outcome: "claimed", message: PLAN_MESSAGES.claimed };
  // The claim API needs the TestMu AI password, so activation on /register makes the claim.
  if (await claimedAtActivation(member)) return { outcome: "claimed", message: PLAN_MESSAGES.claimed };
  const rl = await rateLimit(`testmu-claim:${member.id}`, { limit: 6, windowSec: 600 });
  if (!rl.ok) throw new AppError("RATE_LIMITED", { userMessage: "Too many tries. Wait a few minutes, or ask at the help desk." });

  // Take the claim slot: one attempt at a time per member, never after success.
  const slot = await query<{ member_id: number }>(
    `insert into testmu_plan_claims (member_id, status, last_attempt_at, attempts) values ($1, 'pending', now(), 1)
     on conflict (member_id) do update set last_attempt_at = now(), attempts = testmu_plan_claims.attempts + 1, updated_at = now()
       where testmu_plan_claims.status <> 'claimed'
         and (testmu_plan_claims.status <> 'pending' or testmu_plan_claims.last_attempt_at < now() - interval '20 seconds')
     returning member_id`,
    [member.id],
  );
  if (!slot[0]) {
    const [again] = await query<{ status: string }>("select status from testmu_plan_claims where member_id = $1", [member.id]);
    if (again?.status === "claimed") return { outcome: "claimed", message: PLAN_MESSAGES.claimed };
    return { outcome: "in_progress", message: "Activating… give it a few seconds, then reload." };
  }

  const [{ email }] = await query<{ email: string }>("select email from members where id = $1", [member.id]);
  const answer = await callClaim(email);
  const mapped = mapClaimResponse(answer.status, answer.body, answer.failure);
  const status = mapped.outcome === "claimed" ? "claimed" : mapped.outcome;
  const stored = answer.body === undefined ? null : JSON.stringify(answer.body).slice(0, 8000);

  await transaction(async (tx) => {
    await tx.query(
      `update testmu_plan_claims set status = $2, http_status = $3, response = $4::jsonb, last_error = $5,
              claimed_at = case when $2 = 'claimed' then coalesce(claimed_at, now()) else claimed_at end, updated_at = now()
        where member_id = $1`,
      [member.id, status, answer.status, stored, mapped.detail],
    );
    if (status === "claimed") {
      await tx.query("insert into activation_ticks (member_id, step) values ($1, 'testmu_plan') on conflict do nothing", [member.id]);
      await syncActivated(tx, member.id);
    } else if (status === "not_registered") {
      // Step 1 needs doing again: un-tick it so it is highlighted.
      await tx.query("delete from activation_ticks where member_id = $1 and step = 'testmu_signup'", [member.id]);
    }
    await writeAudit(
      memberActor(member),
      { action: `activation.plan_claim.${status}`, resourceType: "testmu_plan_claim", resourceId: member.id, payload: { http_status: answer.status, target: claimTarget().kind, detail: mapped.detail } },
      tx,
    );
  });
  if (status === "claimed") return { outcome: "claimed", message: PLAN_MESSAGES.claimed };
  if (status === "not_registered") return { outcome: "not_registered", message: PLAN_MESSAGES.notRegistered(email) };
  return { outcome: "error", message: PLAN_MESSAGES.error };
}

// ── Step 3: Codex credit codes ───────────────────────────────────────────────

const OUT_OF_CODES = () => new AppError("CONFLICT", { userMessage: PLAN_MESSAGES.outOfCodes });

/** Assign the next free code inside `tx` (members row already locked). Returns the code or null if the pool is empty. */
async function takeNextCode(tx: PoolClient, memberId: number, assignedBy: string) {
  const { rows } = await tx.query<{ id: number; code: string }>(
    `update codex_credit_codes set status = 'assigned', assigned_member_id = $1, assigned_at = now(), assigned_by = $2
      where id = (select id from codex_credit_codes where status = 'available' and event_id = current_event_id()
                   order by id for update skip locked limit 1)
      returning id, code`,
    [memberId, assignedBy],
  );
  return rows[0] ?? null;
}

/**
 * The member's Codex credit code: their existing one (re-shown, idempotent),
 * or the next available code assigned atomically. Empty pool → a plain
 * "out of codes" error. The audit row carries only the last four characters.
 */
export async function assignCodexCode(member: MemberRow): Promise<{ code: string; assigned_at: Date; reused: boolean }> {
  await requireTeam(member);
  const [t] = await query("select 1 from activation_ticks where member_id = $1 and step = 'testmu_signup'", [member.id]);
  if (!t) throw new AppError("CONFLICT", { userMessage: "Finish step 1 (TestMu AI sign-up) first." });
  return transaction(async (tx) => {
    await tx.query("select id from members where id = $1 for update", [member.id]);
    const { rows: mine } = await tx.query<{ code: string; assigned_at: Date }>("select code, assigned_at from codex_credit_codes where assigned_member_id = $1 and status = 'assigned'", [member.id]);
    if (mine[0]) {
      await tx.query("update codex_credit_codes set revealed_at = coalesce(revealed_at, now()) where assigned_member_id = $1 and status = 'assigned'", [member.id]);
      return { ...mine[0], reused: true };
    }
    const got = await takeNextCode(tx, member.id, "system");
    if (!got) {
      // Outside the transaction (which rolls back), so staff can see who hit an empty pool.
      await writeAudit(memberActor(member), { action: "codex_code.pool_empty", resourceType: "codex_credit_code", resourceId: member.id });
      throw OUT_OF_CODES();
    }
    const { rows } = await tx.query<{ assigned_at: Date }>("update codex_credit_codes set revealed_at = now() where id = $1 returning assigned_at", [got.id]);
    await writeAudit(memberActor(member), { action: "codex_code.assign", resourceType: "codex_credit_code", resourceId: got.id, payload: { member_id: member.id, code_suffix: got.code.slice(-4), by: "system" } }, tx);
    return { code: got.code, assigned_at: rows[0].assigned_at, reused: false };
  });
}

// ── Organizer: import, inventory, assignments ────────────────────────────────

export type ImportPreview = { total: number; fresh: number; duplicates: number; duplicatesInFile: number; duplicatesInDb: number; invalid: { line: number; value: string }[] };

export async function previewCodexImport(text: string): Promise<ImportPreview & { codes: { code: string; extra: Record<string, string> }[] }> {
  const parsed = parseCodexCodes(text);
  const existing = parsed.rows.length
    ? new Set((await query<{ code: string }>("select code from codex_credit_codes where code = any($1::text[])", [parsed.rows.map((r) => r.code)])).map((r) => r.code))
    : new Set<string>();
  const fresh = parsed.rows.filter((r) => !existing.has(r.code));
  return {
    total: parsed.rows.length + parsed.duplicatesInFile + parsed.invalid.length,
    fresh: fresh.length,
    duplicatesInFile: parsed.duplicatesInFile,
    duplicatesInDb: existing.size,
    duplicates: parsed.duplicatesInFile + existing.size,
    invalid: parsed.invalid.slice(0, 50),
    codes: fresh,
  };
}

export async function importCodexCodes(staff: Staff, text: string, batch: string | null) {
  const preview = await previewCodexImport(text);
  if (!preview.codes.length) throw new AppError("VALIDATION_FAILED", { userMessage: "No new codes in that upload." });
  return withAudit(staffActor(staff), "codex_code.import", "codex_credit_code", async (tx) => {
    const { rowCount } = await tx.query(
      `insert into codex_credit_codes (code, batch, extra)
       select c.code, $2, c.extra from jsonb_to_recordset($1::jsonb) as c(code text, extra jsonb)
       on conflict (code) do nothing`,
      [JSON.stringify(preview.codes), batch],
    );
    const counts = { imported: rowCount ?? 0, duplicates: preview.duplicates, invalid: preview.invalid.length, batch };
    return { result: counts, resourceId: batch ?? "import", after: counts };
  });
}

export type Inventory = { total: number; available: number; assigned: number; revoked: number };

export async function codexInventory(): Promise<Inventory> {
  const [row] = await query<Inventory>(
    `select count(*)::int as total, count(*) filter (where status = 'available')::int as available,
            count(*) filter (where status = 'assigned')::int as assigned, count(*) filter (where status = 'revoked')::int as revoked
       from codex_credit_codes where event_id = current_event_id()`,
  );
  return row;
}

export type ActivationFilter = "all" | "not_started" | "stuck_plan" | "missing_code" | "done";

export type ActivationRow = {
  member_id: number;
  name: string;
  email_hint: string;
  public_code: string | null;
  team_name: string | null;
  testmu_signup: boolean;
  plan_status: PlanClaim["status"] | null;
  plan_error: string | null;
  plan_http: number | null;
  code_id: number | null;
  code_masked: string | null;
  code_assigned_at: Date | null;
  codex_done: boolean;
  activated_at: Date | null;
};

/** Every participant with their checklist progress. Codes are masked here. */
export async function listActivation(opts: { q?: string; filter?: ActivationFilter; limit?: number } = {}): Promise<ActivationRow[]> {
  const q = opts.q?.trim().toLowerCase() || null;
  const rows = await query<Omit<ActivationRow, "email_hint" | "code_masked"> & { email: string; code: string | null }>(
    `select m.id as member_id, coalesce(m.display_name, m.name) as name, m.email, m.public_code, t.name as team_name,
            exists (select 1 from activation_ticks a where a.member_id = m.id and a.step = 'testmu_signup') as testmu_signup,
            c.status as plan_status, c.last_error as plan_error, c.http_status as plan_http,
            k.id as code_id, k.code, k.assigned_at as code_assigned_at,
            exists (select 1 from activation_ticks a where a.member_id = m.id and a.step = 'codex_credits') as codex_done,
            m.activated_at
       from members m
       left join teams t on t.id = m.team_id
       left join testmu_plan_claims c on c.member_id = m.id
       left join codex_credit_codes k on k.assigned_member_id = m.id and k.status = 'assigned'
      where m.deleted_at is null and m.role = 'participant'
        and ($1::text is null or lower(m.name) like '%' || $1 || '%' or lower(coalesce(m.display_name, '')) like '%' || $1 || '%'
             or lower(m.email) like '%' || $1 || '%' or lower(coalesce(t.name, '')) like '%' || $1 || '%'
             or (length($1) >= 3 and lower(right(coalesce(k.code, ''), 4)) like '%' || $1 || '%'))
      order by m.activated_at nulls first, m.id
      limit $2`,
    [q, opts.limit ?? 500],
  );
  const out = rows.map(({ email, code, ...r }) => ({ ...r, email_hint: maskEmail(email), code_masked: code ? maskCode(code) : null }));
  switch (opts.filter) {
    case "not_started":
      return out.filter((r) => !r.testmu_signup && !r.plan_status && !r.code_id);
    case "stuck_plan":
      return out.filter((r) => r.plan_status === "error" || r.plan_status === "not_registered");
    case "missing_code":
      return out.filter((r) => r.testmu_signup && !r.code_id);
    case "done":
      return out.filter((r) => r.activated_at);
    default:
      return out;
  }
}

/** Organizer reveals one code in full (audited). */
export async function revealCodexCode(staff: Staff, codeId: number) {
  return withAudit(staffActor(staff), "codex_code.reveal", "codex_credit_code", async (tx) => {
    const { rows } = await tx.query<{ code: string }>("select code from codex_credit_codes where id = $1", [codeId]);
    if (!rows[0]) throw new AppError("NOT_FOUND");
    return { result: rows[0].code, resourceId: codeId };
  });
}

/** Revoke a code (reason required). Revoked codes are never handed out again. */
export async function revokeCodexCode(staff: Staff, codeId: number, reason: string) {
  if (reason.trim().length < 5) throw new AppError("VALIDATION_FAILED", { userMessage: "Give a reason (5+ characters)." });
  return withAudit(staffActor(staff), "codex_code.revoke", "codex_credit_code", async (tx) => {
    const { rows } = await tx.query<{ assigned_member_id: number | null; now: Date }>(
      "update codex_credit_codes set status = 'revoked', revoked_reason = $2, revoked_at = now() where id = $1 and status <> 'revoked' returning assigned_member_id, now() as now",
      [codeId, reason.trim().slice(0, 300)],
    );
    if (!rows[0]) throw new AppError("NOT_FOUND", { userMessage: "That code is already revoked or doesn't exist." });
    if (rows[0].assigned_member_id) await tx.query("delete from activation_ticks where member_id = $1 and step = 'codex_credits'", [rows[0].assigned_member_id]);
    return { result: { id: `CDX-${codeId}`, server_time: rows[0].now.toISOString() }, resourceId: codeId, reason };
  });
}

/** Give a member a fresh code: revokes their current one (if any) and assigns the next available. */
export async function reassignCodexCode(staff: Staff, memberId: number, reason: string) {
  if (reason.trim().length < 5) throw new AppError("VALIDATION_FAILED", { userMessage: "Give a reason (5+ characters)." });
  const actor: Actor = staffActor(staff);
  return withAudit(actor, "codex_code.reassign", "member", async (tx) => {
    await tx.query("select id from members where id = $1 for update", [memberId]);
    const { rows: old } = await tx.query<{ id: number }>(
      "update codex_credit_codes set status = 'revoked', revoked_reason = $2, revoked_at = now() where assigned_member_id = $1 and status = 'assigned' returning id",
      [memberId, `reassigned: ${reason.trim()}`.slice(0, 300)],
    );
    const got = await takeNextCode(tx, memberId, `staff:${staff.id ?? "admin"}`);
    if (!got) throw OUT_OF_CODES();
    await tx.query("delete from activation_ticks where member_id = $1 and step = 'codex_credits'", [memberId]);
    const { rows } = await tx.query<{ now: Date }>("select now()");
    return {
      result: { id: `CDX-${got.id}`, server_time: rows[0].now.toISOString() },
      resourceId: memberId,
      reason,
      payload: { revoked: old.map((o) => o.id), assigned: got.id, code_suffix: got.code.slice(-4) },
    };
  });
}

/** Organizer CSV export of the pool (full codes: organizer only, audited by the caller's route). */
export async function exportCodexCodes(staff: Staff) {
  const rows = await query<{ code: string; batch: string | null; status: string; name: string | null; email: string | null; team: string | null; assigned_at: Date | null; assigned_by: string | null; revoked_reason: string | null }>(
    `select k.code, k.batch, k.status, coalesce(m.display_name, m.name) as name, m.email, t.name as team, k.assigned_at, k.assigned_by, k.revoked_reason
       from codex_credit_codes k left join members m on m.id = k.assigned_member_id left join teams t on t.id = m.team_id
      where k.event_id = current_event_id() order by k.id`,
  );
  await writeAudit(staffActor(staff), { action: "codex_code.export", resourceType: "codex_credit_code", resourceId: "export", payload: { rows: rows.length } });
  return rows;
}

/** Activation on /register already claimed the plan for this member: record step 2 without another call. */
async function claimedAtActivation(member: MemberRow) {
  const [link] = await query<{ claim_code: string }>(
    "select claim_code from testmu_links where member_id = $1 and revoked_at is null and claim_code = any($2::text[]) order by last_seen_at desc limit 1",
    [member.id, CLAIM_OK_CODES],
  );
  if (!link) return false;
  await transaction(async (tx) => {
    await tx.query(
      `insert into testmu_plan_claims (member_id, status, claimed_at, last_attempt_at) values ($1, 'claimed', now(), now())
       on conflict (member_id) do update set status = 'claimed', claimed_at = coalesce(testmu_plan_claims.claimed_at, now()), last_error = null, updated_at = now()`,
      [member.id],
    );
    await tx.query("insert into activation_ticks (member_id, step) values ($1, 'testmu_plan') on conflict do nothing", [member.id]);
    await syncActivated(tx, member.id);
    await writeAudit(memberActor(member), { action: "activation.plan_claim.claimed", resourceType: "testmu_plan_claim", resourceId: member.id, payload: { target: "activation", testmu_code: link.claim_code } }, tx);
  });
  return true;
}
