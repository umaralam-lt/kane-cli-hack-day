import { randomBytes } from "node:crypto";

// Activate a participant on TestMu AI from their Hack OS profile: we send the
// profile with their password, TestMu creates (or signs in) the account and
// answers with its username and access key. That key is the participant's
// mandatory credential from then on (docs/api/TESTMU_ACCESS.md). The captain
// then moves teammates into their TestMu AI team. Fetch only, no DB.
//
//   TESTMU_PROVISION_URL    POST /api/trials/hack-day/claim {email, password, name, linkedin, twitter, github, source, page_url}
//                           → {code, message, username, access_token, organization_id}
//   TESTMU_TEAM_INVITE_URL  POST /api/trials/hack-day/team/invite {email, password, member_email} → {code, message, organization_id}
//   TESTMU_PROVISION_TOKEN  optional, sent to the claim API as Authorization: Bearer …
//   Outside production with no URL, a stub answers so the flow can be clicked through.
//   `+testmu-<code>` in an email (alex+testmu-ineligible@x.io) picks the stub's answer.

export type ProvisionProfile = {
  name: string;
  email: string;
  /** The TestMu AI password: sent once, never kept. */
  password: string;
  linkedin: string | null;
  x: string | null;
  github: string | null;
  /** Our member id: names the stub account, never sent. */
  external_id: string;
  /** Our /register URL, sent as page_url. */
  page_url: string;
};

export type ProvisionResult =
  | { ok: true; username: string; accessKey: string; email: string | null; organizationId: number | null; code: string | null }
  | {
      ok: false;
      reason: "rejected" | "wrong_password" | "unavailable";
      code: string | null;
      detail: string;
      message: string | null;
      retryAfter: number | null;
      fieldErrors: Record<string, string> | null;
    };

export type InviteRequest = { email: string; password: string; member_email: string };

export type InviteResult = { code: string; done: boolean; message: string | null; organizationId: number | null; retryAfter: number | null };

const TIMEOUT_MS = 10_000;
const isProduction = () => process.env.VERCEL_ENV === "production" || process.env.HACKOS_ENV === "production";
const CLAIM_SOURCE = "kaneclihack.sh";
/** Claim codes that come with the account's credentials. */
export const CLAIM_OK_CODES = ["SIGNEDUP", "JOINED_TEAM", "ALREADY_CLAIMED", "ALREADY_ACTIVE"];
const CLAIM_REFUSED_CODES = ["INELIGIBLE", "INVALID_REQUEST", "REGION_NOT_SUPPORTED", "CAMPAIGN_ENDED"];
/** Invite codes that mean the teammate is, or will be, in the captain's TestMu AI team. */
export const INVITE_DONE_CODES = ["MEMBER_ADDED", "MEMBER_INVITED", "ALREADY_IN_TEAM"];
export const RATE_LIMITED = "RATE_LIMITED";
export const UNAVAILABLE = "UNAVAILABLE";
/** The claim API's field names that differ from our form's. */
const CLAIM_FIELD_NAMES: Record<string, string> = { twitter: "x" };
const RETRY_AFTER_DEFAULT_SEC = 60;
const STUB_TAG = /\+testmu-([a-z_-]+)@/i;
/** The stub's INVALID_CREDENTIALS answer accepts this password, so the wrong-password retry can be clicked through. */
export const STUB_TESTMU_PASSWORD = "testmu-password";
const CLAIM_STUB_STATUS: Record<string, number> = { INVALID_CREDENTIALS: 401, FAILED: 502, INVALID_REQUEST: 422, REGION_NOT_SUPPORTED: 403, CAMPAIGN_ENDED: 410, RATE_LIMITED: 429 };
const INVITE_STUB_STATUS: Record<string, number> = {
  INVALID_CREDENTIALS: 401,
  NOT_TEAM_LEAD: 403,
  INELIGIBLE: 403,
  NOT_HACK_DAY_ORG: 403,
  MEMBER_IN_ANOTHER_TEAM: 409,
  ALREADY_INVITED: 409,
  TEAM_FULL: 409,
  RATE_LIMITED: 429,
};

/**
 * Whether profile → TestMu activation runs: always on previews and locally (stub),
 * in production only once TESTMU_PROVISION_URL is set, so a deploy before TestMu's
 * endpoint exists doesn't stop anyone at the profile step.
 */
export const activationEnabled = () => !!process.env.TESTMU_PROVISION_URL?.trim() || !isProduction();

/** Pull username / access key out of the common response shapes. */
export function credentialsFromBody(body: unknown): { username: string; accessKey: string; email: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const layers = [body as Record<string, unknown>];
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object") layers.push(data as Record<string, unknown>);
  for (const l of layers) {
    const username = [l.username, l.user_name, l.userName].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const accessKey = [l.access_token, l.access_key, l.accessKey].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (username && accessKey) {
      const email = typeof l.email === "string" && l.email.includes("@") ? l.email.trim().toLowerCase() : null;
      return { username: username.trim(), accessKey: accessKey.trim(), email };
    }
  }
  return null;
}

function messageOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const m = (body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error;
  return typeof m === "string" ? m.slice(0, 300) : null;
}

export async function provisionTestmuAccount(profile: ProvisionProfile): Promise<ProvisionResult> {
  const url = process.env.TESTMU_PROVISION_URL?.trim();
  if (!url) {
    if (isProduction()) return unavailableClaim("TESTMU_PROVISION_URL is not set in production");
    return stubClaim(profile);
  }
  const token = process.env.TESTMU_PROVISION_TOKEN;
  const res = await postJson(url, claimBody(profile), token ? { authorization: `Bearer ${token}` } : {});
  if (res.status === null) return unavailableClaim(res.failure);
  return claimResultFrom(res.status, res.body, res.retryAfter);
}

/** The captain (lead) moves one teammate into their TestMu AI team, or invites an email that hasn't signed up yet. */
export async function inviteTestmuMember(req: InviteRequest): Promise<InviteResult> {
  const url = process.env.TESTMU_TEAM_INVITE_URL?.trim();
  if (!url) {
    if (isProduction()) return { code: UNAVAILABLE, done: false, message: "TESTMU_TEAM_INVITE_URL is not set in production", organizationId: null, retryAfter: null };
    return stubInvite(req);
  }
  const res = await postJson(url, { email: req.email.trim().toLowerCase(), password: req.password, member_email: req.member_email.trim().toLowerCase() }, {});
  if (res.status === null) return { code: UNAVAILABLE, done: false, message: null, organizationId: null, retryAfter: null };
  return inviteResultFrom(res.status, res.body, res.retryAfter);
}

/** Whether the captain's confirmation syncs the team to TestMu AI: like activationEnabled, for the invite API. */
export const teamSyncEnabled = () => !!process.env.TESTMU_TEAM_INVITE_URL?.trim() || !isProduction();

/** The claim API's answer → our result, keyed by its `code` (several outcomes are HTTP 200). */
export function claimResultFrom(status: number, body: unknown, retryAfter: string | null): ProvisionResult {
  const code = status === 429 ? RATE_LIMITED : codeOf(body);
  const message = messageOf(body);
  const detail = `HTTP ${status}${code ? ` ${code}` : ""}`;
  const refused = { ok: false as const, code, detail, message, retryAfter: null, fieldErrors: null };
  if (code === RATE_LIMITED) return { ...refused, reason: "unavailable", retryAfter: retryAfterSeconds(retryAfter) };
  if (code === "INVALID_CREDENTIALS") return { ...refused, reason: "wrong_password" };
  if (code === "INVALID_REQUEST") {
    const fieldErrors = fieldErrorsFrom(body);
    return { ...refused, reason: "rejected", fieldErrors, message: message ?? (fieldErrors ? Object.values(fieldErrors).join(" ") : null) };
  }
  if (code && CLAIM_REFUSED_CODES.includes(code)) return { ...refused, reason: "rejected" };
  const creds = status >= 200 && status < 300 ? credentialsFromBody(body) : null;
  if (creds && (code === null || CLAIM_OK_CODES.includes(code))) return { ok: true, ...creds, organizationId: organizationIdOf(body), code };
  return { ...refused, reason: "unavailable", detail: creds || status >= 300 ? detail : `${detail} without username/access_token` };
}

/** The invite API's answer → its code, and whether that teammate is done. */
export function inviteResultFrom(status: number, body: unknown, retryAfter: string | null): InviteResult {
  const code = status === 429 ? RATE_LIMITED : (codeOf(body) ?? (status >= 500 ? UNAVAILABLE : `HTTP_${status}`));
  const done = status >= 200 && status < 300 && INVITE_DONE_CODES.includes(code);
  return { code, done, message: messageOf(body), organizationId: organizationIdOf(body), retryAfter: code === RATE_LIMITED ? retryAfterSeconds(retryAfter) : null };
}

/** Retry-After in seconds (a number or an HTTP date), with a default when it's missing. */
export function retryAfterSeconds(header: string | null): number {
  const n = header?.trim() ? Number(header.trim()) : NaN;
  if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.ceil(n));
  const at = header ? Date.parse(header) : NaN;
  if (Number.isFinite(at)) return Math.max(1, Math.ceil((at - Date.now()) / 1000));
  return RETRY_AFTER_DEFAULT_SEC;
}

function unavailableClaim(detail: string): ProvisionResult {
  return { ok: false, reason: "unavailable", code: null, detail, message: null, retryAfter: null, fieldErrors: null };
}

/** Exactly the claim API's fields. */
function claimBody(p: ProvisionProfile) {
  const x = p.x?.trim();
  return {
    email: p.email.trim().toLowerCase(),
    password: p.password,
    name: p.name || undefined,
    linkedin: p.linkedin || undefined,
    twitter: x ? (/^https?:\/\//i.test(x) || x.startsWith("@") ? x : `@${x}`) : undefined,
    github: p.github || undefined,
    source: CLAIM_SOURCE,
    page_url: p.page_url,
  };
}

async function postJson(url: string, payload: object, extraHeaders: Record<string, string>): Promise<{ status: number; body: unknown; retryAfter: string | null } | { status: null; failure: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null), retryAfter: res.headers.get("retry-after") };
  } catch (e) {
    return { status: null, failure: e instanceof Error ? e.name : "network" };
  }
}

function codeOf(body: unknown): string | null {
  const c = body && typeof body === "object" ? (body as { code?: unknown }).code : null;
  return typeof c === "string" && c.trim() ? c.trim().toUpperCase() : null;
}

function organizationIdOf(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { organization_id?: unknown; data?: { organization_id?: unknown } };
  const v = Number(b.organization_id ?? b.data?.organization_id);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** INVALID_REQUEST's `errors` → one message per field, under our field names. */
function fieldErrorsFrom(body: unknown): Record<string, string> | null {
  const errors = body && typeof body === "object" ? (body as { errors?: unknown }).errors : null;
  if (!errors || typeof errors !== "object") return null;
  const out: Record<string, string> = {};
  for (const [field, msgs] of Object.entries(errors as Record<string, unknown>)) {
    const first = Array.isArray(msgs) ? msgs.find((m) => typeof m === "string") : msgs;
    if (typeof first === "string") out[CLAIM_FIELD_NAMES[field] ?? field] = first.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

function stubCode(email: string, env: string | undefined, fallback: string) {
  const tag = STUB_TAG.exec(email)?.[1] ?? env?.trim();
  return tag ? tag.toUpperCase().replace(/-/g, "_") : fallback;
}

/** The claim API's answers as the spec shapes them, run through the same mapping. */
function stubClaim(p: ProvisionProfile): ProvisionResult {
  const picked = stubCode(p.email, process.env.TESTMU_PROVISION_STUB, "SIGNEDUP");
  const code = picked === "INVALID_CREDENTIALS" && p.password === STUB_TESTMU_PASSWORD ? "SIGNEDUP" : picked;
  const orgId = 7_000_000 + (Number(p.external_id.replace(/\D/g, "")) || 0);
  const body = CLAIM_OK_CODES.includes(code)
    ? { code, message: `${code} (stub)`, user_id: orgId, username: `hack-${p.external_id.replace(/\W/g, "")}`, access_token: `stub_${randomBytes(18).toString("base64url")}`, organization_id: orgId }
    : code === "INVALID_REQUEST"
      ? { code, errors: { twitter: ["The twitter may not be greater than 255 characters."] } }
      : code === RATE_LIMITED
        ? { message: "Too Many Attempts." }
        : { code, message: `${code} (stub)` };
  return claimResultFrom(CLAIM_STUB_STATUS[code] ?? 200, body, code === RATE_LIMITED ? "30" : null);
}

function stubInvite(req: InviteRequest): InviteResult {
  const code = stubCode(req.member_email, process.env.TESTMU_TEAM_INVITE_STUB, "MEMBER_ADDED");
  const body = code === RATE_LIMITED ? { message: "Too Many Attempts." } : { code, message: `${code} (stub)`, member_email: req.member_email, organization_id: 7_000_000 };
  return inviteResultFrom(INVITE_STUB_STATUS[code] ?? 200, body, code === RATE_LIMITED ? "30" : null);
}
