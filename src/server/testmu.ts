import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { query } from "@/lib/db";
import { personalNext } from "@/lib/next-path";
import { getMemberSession, setMemberSession } from "@/lib/session";
import {
  COOKIE_HOURS,
  PRINCIPAL_HEADER,
  TESTMU_COOKIE,
  TESTMU_STATE_COOKIE,
  keyFingerprint,
  signValue,
  unsignValue,
  type KeyCredentials,
  type TestmuPrincipal,
  type TestmuSession,
  type TestmuState,
} from "@/lib/testmu-gate";
import { INVITE_DONE_CODES, RATE_LIMITED, inviteTestmuMember, provisionTestmuAccount, type InviteRequest, type ProvisionResult } from "@/lib/testmu-provision";
import { checkAccessKey, emailFrom } from "@/lib/testmu-verify";
import { AppError, emailHash, siteUrl, writeAudit } from "./core";
import type { MemberRow } from "./auth";
import { rateLimit } from "./ratelimit";
import type { ActingMember } from "./teams";

// TestMu AI access keys (docs/api/TESTMU_ACCESS.md). Two ways in:
//   activation (the main path): after the profile is saved we send it to
//     TestMu AI, which answers with the account's username + access key
//     (activateTestmu). That key is the participant's mandatory credential.
//   connect (optional): TestMu redirects back to /api/v1/auth/testmu/callback
//     with username + access key, or a code we exchange (finishConnect).
// Either way we keep only a fingerprint of the key and set hd_testmu, the
// signed cookie the proxy gates on.
//
// Env (all optional outside production, where a stub stands in):
//   TESTMU_AUTH_URL     TestMu page to send people to; we append redirect_uri + state
//   TESTMU_VERIFY_URL   GET with Basic username:access_key; 2xx = valid key. Email read
//                       from email | data.email | user.email | data.user.email
//   TESTMU_TOKEN_URL    POST {code, redirect_uri} → {username, access_key, email?}, when
//                       TestMu sends a code instead of the key
//   TESTMU_CALLBACK_USERNAME_PARAM / TESTMU_CALLBACK_KEY_PARAM   default username / access_key
//   TESTMU_VERIFY_STUB  stub answer outside production: "valid" (default) | "invalid"

const VERIFY_TIMEOUT_MS = 8000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 255;
/** Longest Retry-After the team sync waits out before it stops. */
const SYNC_MAX_WAIT_SEC = 20;
/** Invite answers about one teammate: the sync carries on with the next. Anything else stops it. */
const SYNC_CONTINUE_CODES = [...INVITE_DONE_CODES, "INELIGIBLE", "NOT_HACK_DAY_ORG", "MEMBER_IN_ANOTHER_TEAM", "ALREADY_INVITED", "INVALID_REQUEST"];
const TEAM_SYNC_MESSAGES: Record<string, (name: string) => string> = {
  MEMBER_ADDED: () => "In your TestMu AI team.",
  MEMBER_INVITED: () => "Invited. Joins your TestMu AI team when they activate TestMu AI on /register.",
  ALREADY_IN_TEAM: () => "Already in your TestMu AI team.",
  NOT_TEAM_LEAD: () => "Your TestMu AI account isn’t the admin of its own Hack Day account, so it can’t add teammates. Ask at the help desk.",
  MEMBER_IN_ANOTHER_TEAM: (n) => `${n} already belongs to another TestMu AI team. Ask at the help desk.`,
  ALREADY_INVITED: (n) => `${n} was already invited to another TestMu AI team. Ask at the help desk.`,
  NOT_HACK_DAY_ORG: (n) => `${n} has a TestMu AI account but hasn’t joined Hack Day yet. They need to finish TestMu AI activation on /register, then retry.`,
  TEAM_FULL: () => "Your TestMu AI team already has 4 people, including pending invites. Ask at the help desk.",
  INVALID_CREDENTIALS: () => "TestMu AI didn’t accept that password. Enter your TestMu AI password and retry.",
  INELIGIBLE: (n) => `${n}’s TestMu AI account isn’t eligible to join a team. Ask at the help desk.`,
  RATE_LIMITED: () => "TestMu AI asked us to slow down. Retry in a minute.",
};

export type VerifiedKey = { username: string; email: string | null };

/** checkAccessKey as AppErrors: TESTMU_KEY_REQUIRED (bad key) or TESTMU_UNAVAILABLE. */
export async function verifyAccessKey(c: KeyCredentials): Promise<VerifiedKey> {
  const r = await checkAccessKey(c);
  if (r.ok) return { username: r.username, email: r.email };
  if (r.reason === "invalid") throw new AppError("TESTMU_KEY_REQUIRED", { userMessage: "That TestMu AI username and access key were not accepted." });
  throw new AppError("TESTMU_UNAVAILABLE", { message: `TestMu verify: ${r.detail}` });
}

/** A one-time code from the redirect → the user's credentials (TESTMU_TOKEN_URL). */
async function exchangeCode(code: string, redirectUri: string): Promise<KeyCredentials & { email: string | null }> {
  const url = process.env.TESTMU_TOKEN_URL?.trim();
  if (!url) throw new AppError("TESTMU_UNAVAILABLE", { message: "TestMu sent a code but TESTMU_TOKEN_URL is not set" });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new AppError("TESTMU_UNAVAILABLE");
  }
  if (!res.ok) throw new AppError("TESTMU_KEY_REQUIRED", { userMessage: "TestMu AI didn't accept that sign-in. Please try connecting again." });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const username = String(body.username ?? body.user_name ?? "").trim();
  const accessKey = String(body.access_key ?? body.accessKey ?? "").trim();
  if (!username || !accessKey) throw new AppError("TESTMU_UNAVAILABLE", { message: "TestMu token response had no username/access_key" });
  return { username, accessKey, email: emailFrom(body) };
}

// ── Linking a TestMu account to a registration ───────────────────────────────

async function memberIdByEmail(email: string | null) {
  if (!email) return null;
  const [m] = await query<{ id: number }>(
    "select id from members where (lower(email) = $1 or email_hash = $2) and deleted_at is null order by id limit 1",
    [email, emailHash(email)],
  );
  return m?.id ?? null;
}

/** Upsert the link row; returns the member it belongs to (if any). Never stores the key. */
export async function recordLink(c: KeyCredentials, v: VerifiedKey, source: "redirect" | "header" | "provision", memberId: number | null) {
  const mid = memberId ?? (await memberIdByEmail(v.email));
  const [row] = await query<{ member_id: number | null }>(
    `insert into testmu_links (testmu_username, member_id, email_hash, key_fingerprint, source)
     values ($1, $2, $3, $4, $5)
     on conflict (lower(testmu_username)) do update
       set member_id = coalesce($2, testmu_links.member_id),
           email_hash = coalesce($3, testmu_links.email_hash),
           key_fingerprint = $4, source = $5, last_seen_at = now(), revoked_at = null,
           provisioned_at = case when $5 = 'provision' then now() else testmu_links.provisioned_at end
     returning member_id`,
    [c.username, mid, v.email ? emailHash(v.email) : null, keyFingerprint(c), source],
  );
  return row?.member_id ?? null;
}

/** The member a TestMu identity belongs to: linked row first, then the same email. */
export async function memberIdForTestmu(p: { u: string; e: string | null }) {
  const [row] = await query<{ member_id: number | null }>(
    "select member_id from testmu_links where lower(testmu_username) = lower($1) and revoked_at is null",
    [p.u],
  );
  if (row?.member_id) return row.member_id;
  const id = await memberIdByEmail(p.e);
  if (id) await query("update testmu_links set member_id = $1 where lower(testmu_username) = lower($2) and member_id is null", [id, p.u]);
  return id;
}

// ── Browser handshake ────────────────────────────────────────────────────────

const callbackUrl = () => siteUrl("/api/v1/auth/testmu/callback");

/** Step 1: remember where to return, then send the person to TestMu AI. */
export async function startConnect(next: string | null): Promise<string> {
  const target = personalNext(next ?? undefined);
  // Signed in as yourself: activation needs your TestMu AI password, which /register asks for.
  const session = await getMemberSession();
  if (session?.personal) return "/register?testmu=failed";
  const auth = process.env.TESTMU_AUTH_URL?.trim();
  // No TestMu login page configured: the profile at /register is where the key comes from.
  if (!auth) return `/register?next=${encodeURIComponent(target)}`;
  const nonce = randomBytes(16).toString("base64url");
  (await cookies()).set(TESTMU_STATE_COOKIE, signValue({ n: nonce, next: target, exp: Date.now() + 15 * 60_000 } satisfies TestmuState), cookieOpts(15 * 60, "/api/v1/auth/testmu"));
  const u = new URL(auth);
  u.searchParams.set("redirect_uri", callbackUrl());
  u.searchParams.set("state", nonce);
  return u.toString();
}

/**
 * Step 2: TestMu redirected back. Check state, get + verify the key, link it,
 * set hd_testmu, and sign the person in when the email matches a registration.
 * Returns where to send the browser next.
 */
export async function finishConnect(params: URLSearchParams): Promise<string> {
  const jar = await cookies();
  const state = unsignValue<TestmuState>(jar.get(TESTMU_STATE_COOKIE)?.value);
  jar.delete({ name: TESTMU_STATE_COOKIE, path: "/api/v1/auth/testmu" });
  if (!state || params.get("state") !== state.n) {
    throw new AppError("TESTMU_KEY_REQUIRED", { userMessage: "That TestMu AI sign-in link expired or didn't start here. Please connect again." });
  }

  const userParam = process.env.TESTMU_CALLBACK_USERNAME_PARAM?.trim() || "username";
  const keyParam = process.env.TESTMU_CALLBACK_KEY_PARAM?.trim() || "access_key";
  let creds: KeyCredentials;
  let emailHint: string | null = null;
  const code = params.get("code");
  if (code && !params.get(keyParam)) {
    const ex = await exchangeCode(code, callbackUrl());
    creds = { username: ex.username, accessKey: ex.accessKey };
    emailHint = ex.email;
  } else {
    const username = params.get(userParam)?.trim();
    const accessKey = params.get(keyParam)?.trim();
    if (!username || !accessKey) throw new AppError("TESTMU_KEY_REQUIRED", { userMessage: "TestMu AI didn't send an access key back. Please connect again." });
    creds = { username, accessKey };
  }

  const verified = await verifyAccessKey(creds);
  const email = verified.email ?? emailHint;
  const session = await getMemberSession();
  const memberId = await recordLink(creds, { ...verified, email }, "redirect", session?.personal ? session.memberId : null);

  await setTestmuCookie({ u: creds.username, e: email, m: memberId });

  if (memberId) {
    // TestMu proved the person owns the registration's email: a personal session.
    if (!session || session.memberId !== memberId || !session.personal) await setMemberSession({ memberId, personal: true });
    await writeAudit({ type: "member", id: memberId }, { action: "testmu.connect", resourceType: "member", resourceId: String(memberId), after: { username: creds.username } });
    return state.next;
  }
  // Connected but not registered here yet: build the profile next.
  return "/register";
}

const cookieOpts = (maxAgeSec: number, path = "/") => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path, maxAge: maxAgeSec });

async function setTestmuCookie(s: Omit<TestmuSession, "exp">) {
  (await cookies()).set(TESTMU_COOKIE, signValue({ ...s, exp: Date.now() + COOKIE_HOURS * 3_600_000 } satisfies TestmuSession), cookieOpts(COOKIE_HOURS * 3600));
}

// ── Activation from the profile (mandatory auth) ─────────────────────────────

export const TESTMU_REVEAL_COOKIE = "hd_testmu_reveal";
export type ActivatedKey = { username: string; access_key: string; member_id: number };

/**
 * Send this member's profile and TestMu AI password to TestMu AI's claim API.
 * TestMu answers with the account's username + access key. We keep only the
 * key's fingerprint (testmu_links), set hd_testmu, and hand the key back once:
 * to an API caller in the response, to a browser through a 10-minute reveal
 * cookie (/register shows it once for Kane CLI / Codex). The password is only
 * passed on to TestMu, never stored. Safe to repeat: TestMu signs the same account in.
 */
export async function activateTestmu(memberId: number, opts: { password: string; reveal?: boolean; setCookie?: boolean }): Promise<ActivatedKey> {
  const [m] = await query<{ name: string; email: string; linkedin: string | null; x_handle: string | null; github_handle: string | null }>(
    "select coalesce(display_name, name) as name, email, linkedin, x_handle, github_handle from members where id = $1 and deleted_at is null",
    [memberId],
  );
  if (!m) throw new AppError("NOT_FOUND", { userMessage: "We couldn't find your profile. Fill it in again at /register." });
  if (opts.password.length < PASSWORD_MIN || opts.password.length > PASSWORD_MAX) {
    throw new AppError("VALIDATION_FAILED", {
      userMessage: "Enter your TestMu AI password (8+ characters).",
      details: { reason: "password_required", issues: [{ path: "testmu_password", message: "Enter your TestMu AI password (8+ characters)." }] },
    });
  }
  const r = await provisionTestmuAccount({
    name: m.name,
    email: m.email.toLowerCase(),
    password: opts.password,
    linkedin: m.linkedin,
    x: m.x_handle,
    github: m.github_handle,
    external_id: `member:${memberId}`,
    page_url: siteUrl("/register"),
  });
  if (!r.ok) {
    await query(
      `insert into testmu_provision_failures (member_id, reason, detail) values ($1, $2, $3)
       on conflict (member_id) do update set reason = $2, detail = $3, tries = testmu_provision_failures.tries + 1, last_at = now()`,
      [memberId, r.reason, `${r.detail}${r.message ? ` · ${r.message}` : ""}`.slice(0, 500)],
    );
    throw activationError(r, m.email.toLowerCase());
  }
  const creds = { username: r.username, accessKey: r.accessKey };
  await recordLink(creds, { username: r.username, email: r.email ?? m.email.toLowerCase() }, "provision", memberId);
  await query("update testmu_links set organization_id = $2, claim_code = $3 where lower(testmu_username) = lower($1)", [r.username, r.organizationId, r.code]);
  await query("delete from testmu_provision_failures where member_id = $1", [memberId]);
  await writeAudit(
    { type: "member", id: memberId },
    { action: "testmu.activate", resourceType: "member", resourceId: String(memberId), after: { username: r.username, code: r.code, organization_id: r.organizationId } },
  );
  if (opts.setCookie !== false) await setTestmuCookie({ u: r.username, e: m.email.toLowerCase(), m: memberId });
  if (opts.reveal) {
    (await cookies()).set(TESTMU_REVEAL_COOKIE, signValue({ u: r.username, k: r.accessKey, exp: Date.now() + 10 * 60_000 }), cookieOpts(10 * 60, "/register"));
  }
  return { username: r.username, access_key: r.accessKey, member_id: memberId };
}

/** The key to show once on /register (then forgotten). */
export async function takeRevealedKey(): Promise<{ username: string; accessKey: string } | null> {
  const jar = await cookies();
  const v = unsignValue<{ u: string; k: string; exp: number }>(jar.get(TESTMU_REVEAL_COOKIE)?.value);
  return v ? { username: v.u, accessKey: v.k } : null;
}

export async function clearRevealedKey() {
  (await cookies()).delete({ name: TESTMU_REVEAL_COOKIE, path: "/register" });
}

export async function disconnect() {
  (await cookies()).delete(TESTMU_COOKIE);
}

/** The verified TestMu identity on this request: cookie (browser) or proxy principal (CLI/MCP). */
export async function getTestmuIdentity(): Promise<TestmuPrincipal | null> {
  const fromCookie = unsignValue<TestmuSession>((await cookies()).get(TESTMU_COOKIE)?.value);
  if (fromCookie) return fromCookie;
  return unsignValue<TestmuPrincipal>((await headers()).get(PRINCIPAL_HEADER));
}

/** For getMember(): a CLI/MCP call that authenticated with its TestMu key alone. */
export async function memberFromPrincipal(load: (id: number) => Promise<MemberRow | null>): Promise<MemberRow | null> {
  const p = unsignValue<TestmuPrincipal>((await headers()).get(PRINCIPAL_HEADER));
  if (!p) return null;
  const id = p.m ?? (await memberIdForTestmu(p));
  return id ? load(id) : null;
}

/** The last activation failure for this member (reason and TestMu's message), or null. Never the password. */
export async function activationFailure(memberId: number): Promise<{ reason: string; message: string | null } | null> {
  const [f] = await query<{ reason: string; detail: string | null }>("select reason, detail from testmu_provision_failures where member_id = $1", [memberId]);
  return f ? { reason: f.reason, message: f.detail?.split(" · ").slice(1).join(" · ") || null } : null;
}

// ── TestMu AI team sync (once the captain confirms the final team) ───────────

/** Each current teammate's TestMu AI team status (the last invite answer), captain excluded. */
export async function teamSyncStatus(teamId: number): Promise<TeamSyncStatus[]> {
  const rows = await query<Omit<TeamSyncStatus, "done">>(
    `select m.id as member_id, coalesce(m.display_name, m.name) as name, s.code, s.message, s.attempted_at
       from team_memberships tm
       join teams t on t.id = tm.team_id
       join members m on m.id = tm.member_id
       left join testmu_team_sync s on s.team_id = tm.team_id and s.member_id = m.id
      where tm.team_id = $1 and tm.left_at is null and m.deleted_at is null and m.id is distinct from t.captain_id
      order by tm.joined_at`,
    [teamId],
  );
  return rows.map((r) => ({ ...r, done: !!r.code && INVITE_DONE_CODES.includes(r.code) }));
}

/** Captain only, after our lock: invite each teammate not done yet into the captain's TestMu AI team, one call at a time. */
export async function syncTestmuTeam(who: ActingMember, teamId: number, password: string): Promise<TeamSyncResult> {
  // Lazy: ./teams imports ./auth, which imports this file.
  const { getTeamInfo } = await import("./teams");
  const team = await getTeamInfo({ id: teamId });
  if (!team) throw new AppError("NOT_FOUND", { userMessage: "Team not found." });
  if (team.captain_id !== who.member.id) throw new AppError("FORBIDDEN", { userMessage: "Only the team captain can do that." });
  if (!team.locked) throw new AppError("CONFLICT", { userMessage: "Confirm the final team first." });
  const pending = (await teamSyncStatus(teamId)).filter((s) => !s.done);
  if (!pending.length) return { attempted: 0, stopped: null };
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new AppError("VALIDATION_FAILED", {
      userMessage: "Enter your TestMu AI password (8+ characters) to add your teammates to your TestMu AI team.",
      details: { issues: [{ path: "testmu_password", message: "Enter your TestMu AI password (8+ characters)." }] },
    });
  }
  const rl = await rateLimit(`testmu-sync:${teamId}`, { limit: 6, windowSec: 300 });
  if (!rl.ok) throw new AppError("RATE_LIMITED", { userMessage: "Too many tries. Wait a few minutes, or ask at the help desk." });
  const [lead] = await query<{ email: string }>("select email from members where id = $1", [who.member.id]);
  const emails = new Map(
    (await query<{ id: number; email: string }>("select id, email from members where id = any($1::bigint[])", [pending.map((p) => p.member_id)])).map((r) => [r.id, r.email]),
  );
  const results: { member_id: number; code: string }[] = [];
  let stopped: string | null = null;
  for (const p of pending) {
    const r = await inviteHonouringRetry({ email: lead.email, password, member_email: emails.get(p.member_id) ?? "" });
    await query(
      `insert into testmu_team_sync (team_id, member_id, code, message, organization_id, attempted_at) values ($1, $2, $3, $4, $5, now())
       on conflict (team_id, member_id) do update set code = $3, message = $4, organization_id = coalesce($5, testmu_team_sync.organization_id), attempted_at = now()`,
      [teamId, p.member_id, r.code, r.message, r.organizationId],
    );
    results.push({ member_id: p.member_id, code: r.code });
    if (!SYNC_CONTINUE_CODES.includes(r.code)) {
      stopped = r.code;
      break;
    }
  }
  await writeAudit(who.actor, { action: "testmu.team_sync", resourceType: "team", resourceId: teamId, payload: { results, stopped } });
  return { attempted: results.length, stopped };
}

/** What to tell people about one teammate's sync status. */
export function teamSyncMessage(code: string | null, name: string): string {
  if (!code) return "Not added to your TestMu AI team yet.";
  return TEAM_SYNC_MESSAGES[code]?.(name) ?? "We couldn’t reach TestMu AI. Retry in a minute.";
}

/** A refused activation as the AppError people see. `details.reason` tells the form what to ask for. */
function activationError(r: Extract<ProvisionResult, { ok: false }>, email: string) {
  const details = { reason: r.reason, testmu_code: r.code };
  if (r.reason === "wrong_password") {
    return new AppError("TESTMU_KEY_REQUIRED", {
      userMessage: `${email} already has a TestMu AI account with a different password. Enter your TestMu AI password for ${email}. Your password here stays the same.`,
      details,
    });
  }
  if (r.reason === "rejected") {
    const issues = r.fieldErrors ? Object.entries(r.fieldErrors).map(([path, message]) => ({ path, message })) : undefined;
    return new AppError("TESTMU_KEY_REQUIRED", {
      userMessage: r.message ? `TestMu AI couldn't activate your account: ${r.message}` : "TestMu AI couldn't activate your account. Check your details, or ask at the help desk.",
      details: { ...details, ...(issues ? { issues } : {}) },
    });
  }
  return new AppError("TESTMU_UNAVAILABLE", {
    message: `provision: ${r.detail}`,
    userMessage: `We couldn't activate your TestMu AI account right now. Try again${r.retryAfter ? ` in about ${r.retryAfter}s` : " in a minute"}.`,
    details: { ...details, ...(r.retryAfter ? { retry_after_sec: r.retryAfter } : {}) },
  });
}

/** One invite call. A 429 with a short Retry-After is waited out and tried once more. */
async function inviteHonouringRetry(req: InviteRequest) {
  const first = await inviteTestmuMember(req);
  const wait = first.code === RATE_LIMITED ? first.retryAfter : null;
  if (!wait || wait > SYNC_MAX_WAIT_SEC) return first;
  await new Promise((r) => setTimeout(r, wait * 1000));
  return inviteTestmuMember(req);
}

export type TeamSyncStatus = { member_id: number; name: string; code: string | null; message: string | null; attempted_at: Date | null; done: boolean };

export type TeamSyncResult = { attempted: number; stopped: string | null };
