// TestMu AI Hack Day claim and team sync against a *throwaway* database and a local
// mock of both TestMu AI APIs (tests/support/testmu-mock.mjs, shaped by the contract):
//   - register → claim → hd_testmu cookie, the key shown once, a link with organization_id
//   - an email with a TestMu AI account under another password: wrong_password, then the
//     TestMu AI password connects it and the site password stays the same
//   - INELIGIBLE is refused with TestMu's message, and a 429 is retryable and says how long
//   - the captain's confirmation locks the roster, then invites each teammate once,
//     waiting out a short Retry-After
//   - a partial failure keeps the lock, and the retry skips teammates already in
//   - a wrong captain password stops at the first call, and a solo team makes no calls
//   - the register API takes testmu_password
//   - no password is ever written to any table, the audit log or a redirect
//
//   QA_DATABASE_URL=postgres://…throwaway… npm run test:db
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createTestmuMock } from "../support/testmu-mock.mjs";

const QA = process.env.QA_DATABASE_URL;
const LIVE = process.env.DATABASE_URL;
const skip = !QA ? "QA_DATABASE_URL not set" : QA === LIVE ? "QA_DATABASE_URL equals DATABASE_URL: refusing to touch the live database" : false;

type Mods = {
  db: typeof import("../../src/lib/db.ts");
  session: typeof import("../../src/lib/session.ts");
  gate: typeof import("../../src/lib/testmu-gate.ts");
  password: typeof import("../../src/lib/password.ts");
  flow: typeof import("../../src/server/flow.ts");
  teams: typeof import("../../src/server/teams.ts");
  testmu: typeof import("../../src/server/testmu.ts");
  act: typeof import("../../src/server/event-activation.ts");
  auth: typeof import("../../src/server/auth.ts");
  register: typeof import("../../src/app/register/actions.ts");
  team: typeof import("../../src/app/team/actions.ts");
  api: typeof import("../../src/app/api/v1/auth/register/route.ts");
  jar: Map<string, string>;
};
let m: Mods;
// The other DB test files tag by the millisecond and run in parallel: the pid keeps this one apart.
const tag = `qa${Date.now().toString(36)}p${process.pid.toString(36)}`;
const email = (s: string) => `${tag}.${s}@example.test`;
// Every password used here is unique to this run, so the final grep can't match anything else.
const pw = (s: string) => `pw-${tag}-${s}`;
const used = new Set<string>();
const mock = createTestmuMock({ ipLimit: 10_000, idBase: 1_000_000 + (Date.now() % 1_000_000) * 100 });
let server: Server;
let base = "";

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = QA;
  process.env.SESSION_SECRET ||= "qa-session-secret-not-for-production";
  process.env.SITE_URL = "http://localhost:3104";
  delete process.env.HACKOS_ENV;
  delete process.env.TESTMU_KEY_REQUIRED;
  server = mock.server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.TESTMU_PROVISION_URL = `${base}${mock.CLAIM}`;
  process.env.TESTMU_TEAM_INVITE_URL = `${base}${mock.INVITE}`;
  // The /activate plan claim must not be called at all once activation claimed it.
  process.env.TESTMU_TRIAL_CLAIM_URL = `${base}/plan-claim-not-expected`;
  const [db, session, gate, password, flow, teams, testmu, act, auth, register, team, api, headers] = await Promise.all([
    import("../../src/lib/db.ts"),
    import("../../src/lib/session.ts"),
    import("../../src/lib/testmu-gate.ts"),
    import("../../src/lib/password.ts"),
    import("../../src/server/flow.ts"),
    import("../../src/server/teams.ts"),
    import("../../src/server/testmu.ts"),
    import("../../src/server/event-activation.ts"),
    import("../../src/server/auth.ts"),
    import("../../src/app/register/actions.ts"),
    import("../../src/app/team/actions.ts"),
    import("../../src/app/api/v1/auth/register/route.ts"),
    import("../support/stubs/next-headers.mjs"),
  ]);
  m = { db, session, gate, password, flow, teams, testmu, act, auth, register, team, api, jar: headers.jar };
  await db.query("update hack_events set team_lock_at = greatest(team_lock_at, now() + interval '2 days') where id = current_event_id()");
});

after(async () => {
  server?.close();
  if (skip || !m) return;
  const members = `(select id from members where email like '${tag}.%')`;
  await m.db.query(`delete from testmu_links where member_id in ${members}`).catch(() => {});
  await m.db.query(`delete from teams where id in (select team_id from team_memberships where member_id in ${members})`).catch(() => {});
  const c = await m.db.pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`delete from member_consents where member_id in ${members}`);
    await c.query("commit");
  } finally {
    c.release();
  }
  await m.db.query(`delete from members where email like '${tag}.%'`).catch(() => {});
  await m.db.pool.end();
});

const redirects: string[] = [];

/** The URL a server action redirected to (redirect() throws NEXT_REDIRECT), or what it returned. */
async function outcome<T>(p: Promise<T>): Promise<{ redirect: string | null; value: T | null }> {
  try {
    return { redirect: null, value: await p };
  } catch (e) {
    const d = (e as { digest?: string }).digest;
    if (!d?.startsWith("NEXT_REDIRECT;")) throw e;
    redirects.push(d.slice("NEXT_REDIRECT;".length));
    return { redirect: d.slice("NEXT_REDIRECT;".length), value: null };
  }
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    f.set(k, v);
    if (k.includes("password") && v) used.add(v);
  }
  return f;
};

/** /register's profile form as a fresh browser: profileAction with these fields. */
async function registerVia(who: string, sitePassword: string, extra: Record<string, string> = {}) {
  m.jar.clear();
  return outcome(m.register.profileAction(null, form({ name: `QA ${who}`, email: email(who), linkedin: `linkedin.com/in/qa-${who}`, x: "@qa_user", password: sitePassword, ...extra })));
}

/** A profile saved without TestMu AI activation (never claimed on TestMu). */
async function registerOnly(who: string) {
  m.jar.clear();
  used.add(pw(who));
  const r = await m.flow.submitProfile({ name: `QA ${who}`, email: email(who), linkedin: `linkedin.com/in/qa-${who}`, x: "@qa_user", password: pw(who) }, null);
  assert.equal(r.kind, "ok");
  return memberId(who);
}

async function memberId(who: string) {
  const [row] = await m.db.query<{ id: number }>("select id from members where lower(email) = lower($1)", [email(who)]);
  return row.id;
}

async function signInAs(id: number) {
  m.jar.clear();
  await m.session.setMemberSession({ memberId: id, personal: true });
}

const acting = async (id: number) => {
  const mem = (await m.auth.getMemberById(id))!;
  return { member: mem, actor: m.auth.memberActor(mem) };
};

/** Captain `cap` creates a team and each of `others` joins it with their own invite code. */
async function teamOf(cap: number, others: number[], name: string) {
  const t = await m.teams.createTeam(await acting(cap), { name: `${tag} ${name}` });
  for (const id of others) {
    const inv = await m.teams.createInvite(await acting(cap), t.teamId, { hours: 24 });
    await m.teams.joinTeam(await acting(id), { code: inv.code, confirm: "on" });
  }
  return t;
}

const calls = (path: string) => mock.state.calls.filter((c: { path: string }) => c.path === path) as { path: string; body: Record<string, string> }[];
const link = async (id: number) =>
  (await m.db.query<{ testmu_username: string; key_fingerprint: string; organization_id: number | null; claim_code: string | null; source: string }>(
    "select testmu_username, key_fingerprint, organization_id, claim_code, source from testmu_links where member_id = $1",
    [id],
  ))[0];
const syncCodes = async (teamId: number) => Object.fromEntries((await m.testmu.teamSyncStatus(teamId)).map((s) => [s.member_id, s.code]));

test("register → claim → hd_testmu cookie, the key once, and a link with organization_id", { skip }, async () => {
  const before = calls(mock.CLAIM).length;
  const out = await registerVia("alex", pw("alex"));
  assert.equal(out.redirect, "/register");
  const sent = calls(mock.CLAIM).slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    email: email("alex"),
    password: pw("alex"),
    name: "QA alex",
    linkedin: "https://www.linkedin.com/in/qa-alex",
    twitter: "@qa_user",
    source: "kaneclihack.sh",
    page_url: "http://localhost:3104/register",
  });
  const id = await memberId("alex");
  const acc = mock.state.accounts.get(email("alex"));
  const row = await link(id);
  assert.equal(row.testmu_username, acc.username);
  assert.equal(row.organization_id, acc.org);
  assert.equal(row.claim_code, "SIGNEDUP");
  assert.equal(row.source, "provision");
  assert.equal(row.key_fingerprint, m.gate.keyFingerprint({ username: acc.username, accessKey: acc.token }));
  const cookie = m.gate.unsignValue<{ u: string; e: string; m: number; exp: number }>(m.jar.get("hd_testmu"));
  assert.deepEqual(cookie && { u: cookie.u, e: cookie.e, m: cookie.m }, { u: acc.username, e: email("alex"), m: id });
  assert.deepEqual(await m.testmu.takeRevealedKey(), { username: acc.username, accessKey: acc.token });
  assert.equal(await m.testmu.activationFailure(id), null);
  // A profile edit on the same device doesn't claim again.
  const again = await outcome(m.register.profileAction(null, form({ name: "QA alex", email: email("alex"), linkedin: "linkedin.com/in/qa-alex", x: "@qa_user", password: "" })));
  assert.equal(again.redirect, "/register");
  assert.equal(calls(mock.CLAIM).length, before + 1);
});

test("an existing TestMu AI account with another password: wrong_password, then its password connects it", { skip }, async () => {
  used.add(pw("bea-testmu"));
  mock.addAccount({ email: email("bea"), password: pw("bea-testmu") });
  const out = await registerVia("bea", pw("bea"));
  assert.equal(out.redirect, "/register?testmu=failed");
  const id = await memberId("bea");
  assert.equal((await m.testmu.activationFailure(id))?.reason, "wrong_password");
  assert.equal(m.jar.get("hd_testmu"), undefined);
  const wrong = await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("bea-guess") })));
  assert.equal(wrong.value?.wrongPassword, true);
  assert.match(wrong.value?.error ?? "", /already has a TestMu AI account with a different password/);
  const right = await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("bea-testmu") })));
  assert.equal(right.redirect, "/register");
  assert.equal((await link(id)).claim_code, "SIGNEDUP");
  assert.equal(await m.testmu.activationFailure(id), null);
  // The site password stays the one chosen here.
  const [{ password_hash }] = await m.db.query<{ password_hash: string }>("select password_hash from members where id = $1", [id]);
  assert.equal(await m.password.verifyPassword(pw("bea"), password_hash), true);
  assert.equal(await m.password.verifyPassword(pw("bea-testmu"), password_hash), false);
});

test("INELIGIBLE is refused with TestMu's message and no key", { skip }, async () => {
  mock.addAccount({ email: email("cid"), password: pw("cid"), eligible: false });
  const out = await registerVia("cid", pw("cid"));
  assert.equal(out.redirect, "/register?testmu=failed");
  const id = await memberId("cid");
  const f = await m.testmu.activationFailure(id);
  assert.equal(f?.reason, "rejected");
  assert.equal(f?.message, "This account is not eligible for the trial.");
  const retry = await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("cid") })));
  assert.match(retry.value?.error ?? "", /not eligible for the trial/);
  assert.equal(retry.value?.wrongPassword, false);
  assert.equal(await link(id), undefined);
  assert.equal(m.jar.get("hd_testmu"), undefined);
});

test("a 429 is retryable: Retry-After reaches the person, and the next try activates", { skip }, async () => {
  mock.force({ api: "claim", email: email("dee"), status: 429, retry_after: 7 });
  const out = await registerVia("dee", pw("dee"));
  assert.equal(out.redirect, "/register?testmu=failed");
  const id = await memberId("dee");
  assert.equal((await m.testmu.activationFailure(id))?.reason, "unavailable");
  mock.force({ api: "claim", email: email("dee"), status: 429, retry_after: 7 });
  const busy = await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("dee") })));
  assert.match(busy.value?.error ?? "", /about 7s/);
  const ok = await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("dee") })));
  assert.equal(ok.redirect, "/register");
  assert.equal((await link(id)).claim_code, "SIGNEDUP");
});

test("confirming the final team locks it, then invites each teammate once, waiting out a short Retry-After", { skip }, async () => {
  for (const who of ["cap1", "ann", "dan"]) assert.equal((await registerVia(who, pw(who))).redirect, "/register");
  const [cap, ann, dan] = await Promise.all(["cap1", "ann", "dan"].map(memberId));
  const ben = await registerOnly("ben"); // never claimed on TestMu AI: gets MEMBER_INVITED
  const t = await teamOf(cap, [ann, ben, dan], "Sync One");
  mock.force({ api: "invite", email: email("ann"), status: 429, retry_after: 1 });
  const before = calls(mock.INVITE).length;
  await signInAs(cap);
  const started = Date.now();
  const out = await outcome(m.team.confirmFinalTeamAction(t.slug, null, form({ confirm: "on", testmu_password: pw("cap1") })));
  assert.equal(out.redirect, "/activate", JSON.stringify(out.value));
  assert.ok(Date.now() - started >= 1000, "waited out Retry-After: 1");
  const sent = calls(mock.INVITE).slice(before);
  assert.deepEqual(
    sent.map((c) => c.body),
    [email("ann"), email("ann"), email("ben"), email("dan")].map((member_email) => ({ email: email("cap1"), password: pw("cap1"), member_email })),
  );
  assert.deepEqual(await syncCodes(t.teamId), { [ann]: "MEMBER_ADDED", [ben]: "MEMBER_INVITED", [dan]: "MEMBER_ADDED" });
  const [lk] = await m.db.query<{ state: string }>("select state from teams where id = $1", [t.teamId]);
  assert.equal(lk.state, "roster_locked");
  const capOrg = mock.state.accounts.get(email("cap1")).org;
  assert.equal(mock.state.accounts.get(email("ann")).org, capOrg);
  // Ben activates later and lands straight in the captain's TestMu AI team.
  await signInAs(ben);
  assert.equal((await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("ben") })))).redirect, "/register");
  const benLink = await link(ben);
  assert.equal(benLink.claim_code, "JOINED_TEAM");
  assert.equal(benLink.organization_id, capOrg);
  // /activate step 2 is recorded from the activation's claim, with no second call.
  const plan = await m.act.claimPlan((await m.auth.getMemberById(ann))!);
  assert.equal(plan.outcome, "claimed");
  const [pc] = await m.db.query<{ status: string; http_status: number | null }>("select status, http_status from testmu_plan_claims where member_id = $1", [ann]);
  assert.deepEqual(pc, { status: "claimed", http_status: null });
  // Confirming again changes nothing and calls nobody.
  await signInAs(cap);
  const n = calls(mock.INVITE).length;
  assert.equal((await outcome(m.team.confirmFinalTeamAction(t.slug, null, form({ confirm: "on", testmu_password: pw("cap1") })))).redirect, "/activate");
  assert.equal(calls(mock.INVITE).length, n);
});

test("a partial failure keeps the lock, and the retry skips teammates already in", { skip }, async () => {
  for (const who of ["cap2", "fay", "hal"]) assert.equal((await registerVia(who, pw(who))).redirect, "/register");
  const [cap, fay, hal] = await Promise.all(["cap2", "fay", "hal"].map(memberId));
  // Gus has a TestMu AI account but never joined Hack Day there.
  mock.addAccount({ email: email("gus"), password: pw("gus"), claimed: false });
  const gus = await registerOnly("gus");
  const t = await teamOf(cap, [fay, gus, hal], "Sync Two");
  mock.force({ api: "invite", email: email("hal"), status: 429, retry_after: 60 });
  await signInAs(cap);
  const out = await outcome(m.team.confirmFinalTeamAction(t.slug, null, form({ confirm: "on", testmu_password: pw("cap2") })));
  assert.equal(out.redirect, "/team?testmu_sync=1#testmu-sync");
  const [lk] = await m.db.query<{ state: string }>("select state from teams where id = $1", [t.teamId]);
  assert.equal(lk.state, "roster_locked", "our lock never depends on TestMu AI");
  assert.deepEqual(await syncCodes(t.teamId), { [fay]: "MEMBER_ADDED", [gus]: "NOT_HACK_DAY_ORG", [hal]: "RATE_LIMITED" });
  assert.match(m.testmu.teamSyncMessage("NOT_HACK_DAY_ORG", "QA gus"), /QA gus .*finish TestMu AI activation on \/register/);
  // Gus finishes activation. The captain retries and only Gus and Hal are called.
  await signInAs(gus);
  assert.equal((await outcome(m.register.retryTestmuAction(null, form({ testmu_password: pw("gus") })))).redirect, "/register");
  await signInAs(cap);
  const before = calls(mock.INVITE).length;
  const retry = await outcome(m.team.retryTestmuSyncAction(t.slug, null, form({ testmu_password: pw("cap2") })));
  assert.deepEqual(retry.value, { ok: true, data: { attempted: 2, stopped: null } });
  assert.deepEqual(calls(mock.INVITE).slice(before).map((c) => c.body.member_email), [email("gus"), email("hal")]);
  assert.deepEqual(await syncCodes(t.teamId), { [fay]: "MEMBER_ADDED", [gus]: "MEMBER_ADDED", [hal]: "MEMBER_ADDED" });
  // A teammate can't run the sync.
  await signInAs(fay);
  const notCaptain = await outcome(m.team.retryTestmuSyncAction(t.slug, null, form({ testmu_password: pw("fay") })));
  assert.equal(notCaptain.value?.ok, false);
});

test("a wrong captain password stops at the first call and leaves the lock", { skip }, async () => {
  for (const who of ["cap3", "ivy", "jon"]) assert.equal((await registerVia(who, pw(who))).redirect, "/register");
  const [cap, ivy, jon] = await Promise.all(["cap3", "ivy", "jon"].map(memberId));
  const t = await teamOf(cap, [ivy, jon], "Sync Three");
  await signInAs(cap);
  const before = calls(mock.INVITE).length;
  const out = await outcome(m.team.confirmFinalTeamAction(t.slug, null, form({ confirm: "on", testmu_password: pw("cap3-typo") })));
  assert.equal(out.redirect, "/team?testmu_sync=1#testmu-sync");
  assert.equal(calls(mock.INVITE).length, before + 1);
  assert.deepEqual(await syncCodes(t.teamId), { [ivy]: "INVALID_CREDENTIALS", [jon]: null });
  const [lk] = await m.db.query<{ state: string }>("select state from teams where id = $1", [t.teamId]);
  assert.equal(lk.state, "roster_locked");
  // No password at all: still locked, no call.
  const n = calls(mock.INVITE).length;
  const none = await outcome(m.team.retryTestmuSyncAction(t.slug, null, form({ testmu_password: "" })));
  assert.equal(none.value?.ok, false);
  assert.equal(calls(mock.INVITE).length, n);
  // An organizer reopened the roster (roster_locked_at stays set): no sync until it is final again.
  await m.db.query("update teams set state = 'active' where id = $1", [t.teamId]);
  const reopened = await outcome(m.team.retryTestmuSyncAction(t.slug, null, form({ testmu_password: pw("cap3") })));
  assert.equal(reopened.value?.ok === false && reopened.value.error.message, "Confirm the final team first.");
  assert.equal(calls(mock.INVITE).length, n);
});

test("a solo team makes no TestMu AI calls", { skip }, async () => {
  assert.equal((await registerVia("solo", pw("solo"))).redirect, "/register");
  const id = await memberId("solo");
  const t = await m.teams.createTeam(await acting(id), { name: `${tag} Solo`, solo: "on" });
  await signInAs(id);
  const before = calls(mock.INVITE).length;
  const out = await outcome(m.team.confirmFinalTeamAction(t.slug, null, form({ confirm: "on" })));
  assert.equal(out.redirect, "/activate");
  assert.equal(calls(mock.INVITE).length, before);
  assert.deepEqual(await m.testmu.teamSyncStatus(t.teamId), []);
});

test("the register API takes testmu_password when the TestMu AI password differs", { skip }, async () => {
  used.add(pw("kim-testmu"));
  mock.addAccount({ email: email("kim"), password: pw("kim-testmu") });
  const post = (body: Record<string, string>) => {
    for (const [k, v] of Object.entries(body)) if (k.includes("password")) used.add(v);
    return m.api.POST(new Request("http://localhost:3104/api/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  };
  const profile = { name: "QA kim", email: email("kim"), linkedin: "linkedin.com/in/qa-kim", x: "@qa_user" };
  // Every run here comes from 127.0.0.1, so earlier runs share the route's per-client limit.
  await m.db.query("delete from rate_limit_buckets where bucket like 'api-register:%'");
  m.jar.clear();
  const first = await (await post({ ...profile, password: pw("kim") })).json();
  assert.equal(first.status, "needs_action");
  assert.equal(first.data.testmu_error.reason, "wrong_password");
  assert.equal(first.data.testmu, null);
  m.jar.clear();
  const second = await (await post({ ...profile, proof_password: pw("kim"), testmu_password: pw("kim-testmu") })).json();
  assert.equal(second.status, "ok");
  assert.equal(second.data.testmu.access_key, mock.state.accounts.get(email("kim")).token);
  assert.ok(!JSON.stringify(first).includes(pw("kim")) && !JSON.stringify(second).includes(pw("kim-testmu")));
});

test("no password is in any table, the audit log or a redirect", { skip }, async () => {
  assert.ok(used.size >= 15, `checked ${used.size} passwords`);
  const tables = await m.db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
  assert.ok(tables.some((t) => t.table_name === "audit_events") && tables.some((t) => t.table_name === "testmu_team_sync"));
  const hits: string[] = [];
  for (const { table_name } of tables) {
    const [row] = await m.db.query<{ n: number }>(`select count(*)::int as n from "${table_name}" x where x::text like any($1::text[])`, [[...used].map((p) => `%${p}%`)]);
    if (row.n) hits.push(`${table_name}: ${row.n}`);
  }
  assert.deepEqual(hits, []);
  // The passwords did reach TestMu AI (the mock), and only in the password field.
  const bodies = (mock.state.calls as { body: Record<string, string> }[]).map((c) => c.body);
  assert.ok(bodies.some((b) => b.password === pw("alex")));
  for (const b of bodies) for (const [k, v] of Object.entries(b)) if (k !== "password") assert.ok(![...used].some((p) => String(v).includes(p)), k);
  // Nor in a redirect or a cookie.
  assert.ok(redirects.length >= 15);
  for (const r of redirects) assert.ok(![...used].some((p) => r.includes(p)), r);
  for (const v of m.jar.values()) assert.ok(![...used].some((p) => v.includes(p)));
});
