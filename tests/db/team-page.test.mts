// The team submission page API (docs/api/TEAM_PAGE.md) against a *throwaway* database (same guard as tier0):
//   - create, update and readback, by team id and by slug
//   - an idempotent replay returns the same receipt without a version bump
//   - a stale expected_version is 409 with the current version
//   - a non-member is FORBIDDEN, staff read, only organizers write
//   - another team's or non-public evidence, and a bad video URL, are refused
//   - after the lock a participant gets SUBMISSION_LOCKED and an organizer may write (audited)
//   - a finalized submission's snapshot and draft never change
//   - /ship/{slug}/one-pager visibility and headers, the REST route and the MCP tool,
//     fetched from a running dev server on the same database (QA_SITE_URL)
//
// Lock times come from a QA hack_events row that current_event_id() points at in this process only.
// The dev server still sees the live event, so its checks don't depend on any lock.
//
//   QA_DATABASE_URL=postgres://…throwaway… [QA_SITE_URL=http://127.0.0.1:3103] npm run test:db
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const QA = process.env.QA_DATABASE_URL;
const LIVE = process.env.DATABASE_URL;
const SITE = process.env.QA_SITE_URL?.replace(/\/$/, "");
const skip = !QA ? "QA_DATABASE_URL not set" : QA === LIVE ? "QA_DATABASE_URL equals DATABASE_URL: refusing to touch the live database" : false;
const skipSite = skip || (!SITE ? "QA_SITE_URL not set: start `next dev` on QA_DATABASE_URL with the same SESSION_SECRET" : false);

type Mods = {
  db: typeof import("../../src/lib/db.ts");
  page: typeof import("../../src/server/team-page.ts");
  session: typeof import("../../src/lib/session.ts");
  jar: Map<string, string>;
};
type MemberRow = import("../../src/server/auth.ts").MemberRow;
type Caller = import("../../src/server/team-page.ts").PageCaller;
type Team = { id: number; slug: string; project: number; members: number[] };

let m: Mods;
const tag = `qa${Date.now().toString(36)}`;
const SHA = "b".repeat(40);
const teams: Team[] = [];
const staff = { organizer: 0, judge: 0 };
const pe = { video: 0, shot: 0, pending: 0, other: 0 };
const runs = { own: 0, other: 0 };
const token = `khk_${tag}_page`;
const schema = `qa_page_${tag}`;
let eventId = 0;

before(async () => {
  if (skip) return;
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: QA });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: number }>(
      `insert into hack_events (slug, name, starts_at, team_lock_at, idea_lock_at, submission_locks_at, demos_start_at)
       values ($1, 'QA team page', now(), now() + interval '2 days', now() + interval '2 days', now() + interval '2 days', now() + interval '2 days') returning id`,
      [`${tag}-event`],
    );
    eventId = Number(rows[0].id);
    await c.query(`create schema ${schema}`);
    await c.query(`create function ${schema}.current_event_id() returns bigint language sql stable as $$ select ${eventId}::bigint $$`);
  } finally {
    await c.end();
  }
  // Every connection this process opens resolves current_event_id() to the QA event first.
  const url = new URL(QA!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET ||= "qa-session-secret-not-for-production";
  process.env.EVIDENCE_CDN_BASE_URL ||= "https://evidence.example.test";
  const [db, page, session, headers] = await Promise.all([
    import("../../src/lib/db.ts"),
    import("../../src/server/team-page.ts"),
    import("../../src/lib/session.ts"),
    import("../support/stubs/next-headers.mjs"),
  ]);
  m = { db, page, session, jar: headers.jar };
  // Teams 0 and 1 for the API, team 2 for the finalized snapshot, team 3 for the dev server.
  for (let t = 0; t < 4; t++) {
    const slug = `${tag}-p${t}`;
    const [team] = await db.query<{ id: number }>("insert into teams (slug, name, track, idea, password_hash) values ($1, $2, 'web', 'qa', 'x') returning id", [slug, `${tag} page ${t}`]);
    const [project] = await db.query<{ id: number }>("insert into projects (team_id, name, slug) values ($1, $2, $3) returning id", [team.id, `${tag} page ${t}`, slug]);
    const members: number[] = [];
    for (let i = 0; i < 2; i++) {
      const [mem] = await db.query<{ id: number }>("insert into members (team_id, name, email) values ($1, $2, $3) returning id", [team.id, `QA page ${t}.${i}`, `${tag}.p${t}.${i}@example.test`]);
      await db.query("insert into team_memberships (team_id, member_id, role) values ($1, $2, $3)", [team.id, mem.id, i === 0 ? "captain" : "member"]);
      members.push(mem.id);
    }
    teams.push({ id: team.id, slug, project: project.id, members });
  }
  for (const role of ["organizer", "judge"] as const) {
    const [s] = await db.query<{ id: number }>("insert into staff_accounts (email, name, role, active) values ($1, $2, $3, true) returning id", [`${tag}.${role}@example.test`, `QA ${role}`, role]);
    staff[role] = s.id;
  }
  const evidence = async (project: number, kind: string, status: string, name: string) => {
    const sha = createHash("sha256").update(`${tag}-${name}`).digest("hex");
    const [r] = await db.query<{ id: number }>(
      `insert into public_evidence (project_id, kind, sha256, size_bytes, content_type, original_name, object_key, status, completed_at)
       values ($1, $2, $3, 100, $4, $5, $6, $7, now()) returning id`,
      [project, kind, sha, kind === "video" ? "video/mp4" : "image/png", name, `p${project}/${sha}/${name}`, status],
    );
    return r.id;
  };
  pe.video = await evidence(teams[0].project, "video", "public", "demo.mp4");
  pe.shot = await evidence(teams[0].project, "screenshot", "public", "shot.png");
  pe.pending = await evidence(teams[0].project, "screenshot", "pending", "pending.png");
  pe.other = await evidence(teams[1].project, "screenshot", "public", "theirs.png");
  const run = async (t: Team, id: string) =>
    (
      await db.query<{ id: number }>(
        "insert into kane_runs (project_id, team_id, source, upstream_execution_id, status, commit_sha, source_verified, verification_state) values ($1, $2, 'kanehack_cli', $3, 'passed', $4, true, 'verified') returning id",
        [t.project, t.id, id, SHA],
      )
    )[0].id;
  runs.own = await run(teams[0], `${tag}-run-own`);
  runs.other = await run(teams[1], `${tag}-run-other`);
  await db.query("insert into deck_versions (project_id, version, scenes) values ($1, 1, '[]')", [teams[0].project]);
});

after(async () => {
  if (skip || !m) return;
  await m.db.query("delete from teams where id = any($1::bigint[])", [teams.map((t) => t.id)]).catch(() => {});
  await m.db.query("delete from staff_accounts where id = any($1::bigint[])", [[staff.organizer, staff.judge]]).catch(() => {});
  await m.db.query("delete from hack_events where id = $1", [eventId]).catch(() => {});
  await m.db.query(`drop schema if exists ${schema} cascade`).catch(() => {});
  await m.db.pool.end();
});

const memberRow = async (id: number) =>
  (await m.db.query<MemberRow>("select id, team_id, name, display_name, email, 'participant' as role, public_code, checked_in_at, activated_at, deleted_at from members where id = $1", [id]))[0];
const asMember = async (id: number): Promise<Caller> => ({ member: await memberRow(id), staff: null, actor: null, source: "web" });
const asStaff = (role: "organizer" | "judge"): Caller => ({ member: null, staff: { id: staff[role], name: `QA ${role}`, email: null, role }, actor: null, source: "web" });
const code = (c: string) => (e: { code?: string }) => e.code === c;

test("create, update and readback by team id and by slug", { skip }, async () => {
  const t = teams[0];
  const me = await asMember(t.members[0]);
  const empty = await m.page.getTeamPage(String(t.id), me);
  assert.equal(empty.page_version, 0);
  assert.equal(empty.statuses.repo, "missing");
  assert.match(empty.canonical_url, new RegExp(`/ship/${t.slug}$`));

  const w = await m.page.updateTeamPage(t.slug, me, {
    repo_url: "https://github.com/example/qa-page",
    commit_sha: SHA.toUpperCase(),
    one_pager_html: "<h1>QA one-pager</h1>",
    video: { public_evidence_id: `PE-${pe.video}` },
    deck: { version: 1 },
    evidence_ids: [`PE-${pe.shot}`],
    kane_run_ids: [`KR-${runs.own}`],
    share_links: ["https://kane.lambdatest.com/share/abc123"],
  });
  assert.equal(w.receipt?.page_version, 1);
  assert.equal(w.receipt?.id, `PAGE-${t.id}-v1`);
  assert.deepEqual([...(w.receipt?.changed ?? [])].sort(), ["commit_sha", "deck", "evidence_ids", "kane_run_ids", "one_pager_html", "repo_url", "share_links", "video"]);

  const r = await m.page.getTeamPage(String(t.id), me);
  assert.equal(r.page_version, 1);
  assert.equal(r.slug, t.slug);
  assert.equal(r.commit_sha, SHA);
  assert.equal(r.video?.source, "public_evidence");
  assert.equal(r.video?.source === "public_evidence" && r.video.public_evidence_id, `PE-${pe.video}`);
  assert.deepEqual(r.evidence.map((e) => e.id), [`PE-${pe.shot}`]);
  assert.ok(r.evidence[0].url.startsWith("https://evidence.example.test/"));
  assert.deepEqual(r.kane_run_ids, [runs.own]);
  assert.equal(r.deck && "version" in r.deck && r.deck.version, 1);
  assert.equal(r.share_links[0].state, "expires");
  assert.equal(new Date(r.share_links[0].expires_at).getTime() - new Date(r.share_links[0].added_at).getTime(), 7 * 86_400_000);
  assert.match(r.one_pager_url ?? "", new RegExp(`/ship/${t.slug}/one-pager$`));
  assert.deepEqual(r.statuses, { repo: "linked", one_pager: "linked", video: "linked", deck: "linked", evidence: 1, published: false });

  // One source of truth: the Submit tab's draft and the project row carry the same values.
  const [sub] = await m.db.query<{ draft: { repo_url: string; video_url: string; kane_run_ids: number[] } }>("select draft from submissions where project_id = $1 and status = 'draft'", [t.project]);
  assert.equal(sub.draft.repo_url, "https://github.com/example/qa-page");
  assert.equal(sub.draft.video_url, r.video?.url);
  const [proj] = await m.db.query<{ repo_url: string }>("select repo_url from projects where id = $1", [t.project]);
  assert.equal(proj.repo_url, "https://github.com/example/qa-page");

  // Omitted stays, null clears, and an unchanged write doesn't bump the version.
  const u = await m.page.updateTeamPage(String(t.id), me, { share_links: null, expected_version: 1 });
  assert.equal(u.page_version, 2);
  assert.deepEqual(u.share_links, []);
  assert.equal(u.repo_url, "https://github.com/example/qa-page");
  const same = await m.page.updateTeamPage(t.slug, me, { commit_sha: SHA, evidence_ids: [`PE-${pe.shot}`] });
  assert.equal(same.page_version, 2);
  assert.deepEqual(same.receipt?.changed, []);
});

test("an idempotent replay returns the same receipt and doesn't bump the version", { skip }, async () => {
  const t = teams[0];
  const me = await asMember(t.members[1]);
  const key = `${tag}-replay-1`;
  const a = await m.page.updateTeamPage(t.slug, me, { one_pager_html: "<p>v-replay</p>", idempotency_key: key });
  const b = await m.page.updateTeamPage(t.slug, me, { one_pager_html: "<p>v-replay</p>", idempotency_key: key });
  assert.equal(a.receipt?.id, b.receipt?.id);
  assert.equal(b.replayed, true);
  assert.equal(b.page_version, a.page_version);
});

test("a stale expected_version is 409 with the current version", { skip }, async () => {
  const t = teams[0];
  const me = await asMember(t.members[0]);
  const cur = (await m.page.getTeamPage(t.slug, me)).page_version;
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { commit_sha: "c".repeat(40), expected_version: cur - 1 }), (e: { code?: string; status?: number; details?: { current_version?: number } }) => e.code === "CONFLICT" && e.status === 409 && e.details?.current_version === cur);
  assert.equal((await m.page.getTeamPage(t.slug, me)).commit_sha, SHA);
});

test("a non-member is FORBIDDEN, staff read, and only organizers write", { skip }, async () => {
  const t = teams[0];
  const outsider = await asMember(teams[1].members[0]);
  await assert.rejects(m.page.getTeamPage(t.slug, outsider), code("FORBIDDEN"));
  await assert.rejects(m.page.updateTeamPage(t.slug, outsider, { commit_sha: SHA }), code("FORBIDDEN"));
  await assert.rejects(m.page.getTeamPage(t.slug, { member: null, staff: null, actor: null, source: "web" }), code("UNAUTHENTICATED"));
  assert.equal((await m.page.getTeamPage(t.slug, asStaff("judge"))).team_id, t.id);
  await assert.rejects(m.page.updateTeamPage(t.slug, asStaff("judge"), { commit_sha: SHA }), code("FORBIDDEN"));
  assert.equal((await m.page.updateTeamPage(t.slug, asStaff("organizer"), { commit_sha: SHA })).team_id, t.id);
});

test("another team's or non-public evidence, other runs and bad links are refused", { skip }, async () => {
  const t = teams[0];
  const me = await asMember(t.members[0]);
  const refused = (e: { code?: string; details?: { refused?: string[] } }) => e.code === "VALIDATION_FAILED";
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { evidence_ids: [`PE-${pe.other}`] }), (e: { code?: string; details?: { refused?: string[] } }) => refused(e) && e.details?.refused?.[0] === `PE-${pe.other}`);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { evidence_ids: [`PE-${pe.pending}`] }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { evidence_ids: ["not-an-id"] }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { video: { public_evidence_id: `PE-${pe.shot}` } }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { kane_run_ids: [runs.other] }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { video: { url: "https://evil.example/demo.mp4" } }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { video: { url: "http://youtube.com/watch?v=abcdefgh" } }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { video: { url: "https://youtube.com.evil.example/x" } }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { repo_url: "https://gitlab.com/example/qa" }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { share_links: ["https://example.com/share/1"] }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { one_pager_html: "x".repeat(262_145) }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { deck: { version: 99 } }), refused);
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { video_url: "https://youtu.be/abcdefgh" }), refused);
  const ok = await m.page.updateTeamPage(t.slug, me, { video: { url: "https://www.youtube.com/watch?v=abcdefgh" } });
  assert.deepEqual(ok.video, { source: "url", url: "https://www.youtube.com/watch?v=abcdefgh" });
  const page = await m.page.getTeamPage(t.slug, me);
  assert.deepEqual(page.evidence_ids, [`PE-${pe.shot}`]);
});

test("after the lock a participant is refused and an organizer may write, audited", { skip }, async () => {
  const t = teams[1];
  const me = await asMember(t.members[0]);
  await m.db.query("update hack_events set submission_locks_at = now() - interval '1 minute' where id = $1", [eventId]);
  try {
    await assert.rejects(m.page.updateTeamPage(t.slug, me, { commit_sha: SHA }), (e: { code?: string; status?: number }) => e.code === "SUBMISSION_LOCKED" && e.status === 423);
    const w = await m.page.updateTeamPage(t.slug, asStaff("organizer"), { commit_sha: SHA });
    assert.equal(w.commit_sha, SHA);
  } finally {
    await m.db.query("update hack_events set submission_locks_at = now() + interval '2 days' where id = $1", [eventId]);
  }
  const [audit] = await m.db.query<{ actor_type: string; actor_id: number; payload: { after_lock: boolean; by_organizer: boolean } }>(
    "select actor_type, actor_id, payload from audit_events where action = 'team_page.update' and resource_id = $1 order by id desc limit 1",
    [String(t.project)],
  );
  assert.equal(audit.actor_type, "staff");
  assert.equal(audit.actor_id, staff.organizer);
  assert.equal(audit.payload.after_lock, true);
  assert.equal(audit.payload.by_organizer, true);
});

test("a finalized submission's snapshot and draft never change", { skip }, async () => {
  const t = teams[2];
  const me = await asMember(t.members[0]);
  const draft = { project_name: "QA final", repo_url: "https://github.com/example/qa-final", commit_sha: SHA, kane_run_ids: [] };
  const snapshot = { schema: "kane-hack-os.submission@1", receipt_code: `S-${tag.slice(-4).toUpperCase()}`, submission: draft };
  await m.db.query(
    `insert into submissions (project_id, team_id, status, draft, receipt_code, finalized_by, finalized_at, immutable_snapshot, snapshot_sha256)
     values ($1, $2, 'finalized', $3, $4, $5, now(), $6, $7)`,
    [t.project, t.id, JSON.stringify(draft), snapshot.receipt_code, t.members[0], JSON.stringify(snapshot), "d".repeat(64)],
  );
  const read = async () => (await m.db.query<{ draft: unknown; immutable_snapshot: unknown; snapshot_sha256: string }>("select draft, immutable_snapshot, snapshot_sha256 from submissions where project_id = $1", [t.project]))[0];
  const before = await read();
  await assert.rejects(m.page.updateTeamPage(t.slug, me, { repo_url: "https://github.com/example/changed" }), (e: { code?: string; details?: { receipt_code?: string } }) => e.code === "CONFLICT" && e.details?.receipt_code === snapshot.receipt_code);
  const ok = await m.page.updateTeamPage(t.slug, me, { repo_url: draft.repo_url, one_pager_html: "<p>after finalize</p>" });
  assert.deepEqual(ok.receipt?.changed, ["one_pager_html"]);
  assert.equal(ok.statuses.repo, "submitted");
  assert.deepEqual(await read(), before);
});

test("one-pager visibility and headers, the REST route and the MCP tool on the dev server", { skip: skipSite }, async () => {
  const t = teams[3];
  const me = await asMember(t.members[0]);
  await m.page.updateTeamPage(t.slug, me, { one_pager_html: "<h1>first</h1>" });
  const url = `${SITE}/ship/${t.slug}/one-pager`;
  const cookieFor = async (set: () => Promise<void>) => {
    m.jar.clear();
    await set();
    return [...m.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  };
  const memberCookie = await cookieFor(() => m.session.setMemberSession({ memberId: t.members[1], personal: true }));
  const staffCookie = await cookieFor(() => m.session.setStaffSession(staff.judge, "judge"));
  const organizerCookie = await cookieFor(() => m.session.setStaffSession(staff.organizer, "organizer"));
  const outsiderCookie = await cookieFor(() => m.session.setMemberSession({ memberId: teams[1].members[0], personal: true }));
  const get = (cookie?: string) => fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });

  // Draft page: team members and staff only.
  assert.equal((await get()).status, 404);
  assert.equal((await get(outsiderCookie)).status, 404);
  const mine = await get(memberCookie);
  assert.equal(mine.status, 200);
  assert.equal(await mine.text(), "<h1>first</h1>");
  assert.equal(mine.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = mine.headers.get("content-security-policy") ?? "";
  assert.match(csp, /(^|[;,]\s*)sandbox allow-scripts(;|,|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms/);
  assert.equal(mine.headers.get("x-content-type-options"), "nosniff");
  assert.equal(mine.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await get(staffCookie)).status, 200);

  // Published and public: visitors see what was saved before the publish, never a later save.
  const [story] = await m.db.query<{ id: number }>("insert into project_stories (project_id, version, content) values ($1, 1, '{}') returning id", [t.project]);
  await m.db.query("insert into published_assets (project_id, kind, version, source_story_id, state) values ($1, 'ship_page', 1, $2, 'public')", [t.project, story.id]);
  await m.db.query("update projects set showcase_state = 'public' where id = $1", [t.project]);
  const visitor = await get();
  assert.equal(visitor.status, 200);
  assert.equal(await visitor.text(), "<h1>first</h1>");
  const later = await m.page.updateTeamPage(t.slug, me, { one_pager_html: "<h1>second</h1>" });
  assert.equal(later.statuses.one_pager, "pending_publish");
  assert.equal((await get()).status, 404);
  assert.equal(await (await get(memberCookie)).text(), "<h1>second</h1>");
  await m.db.query("update projects set showcase_state = 'hidden_by_moderation' where id = $1", [t.project]);
  await m.db.query("insert into published_assets (project_id, kind, version, source_story_id, state) values ($1, 'ship_page', 2, $2, 'public')", [t.project, story.id]);
  assert.equal((await get()).status, 404);
  await m.db.query("update projects set showcase_state = 'unlisted' where id = $1", [t.project]);
  assert.equal(await (await get()).text(), "<h1>second</h1>");

  // REST: readback by id, then an organizer PUT (allowed whatever the live lock says) whose Idempotency-Key header replays.
  const api = `${SITE}/api/v1/teams/${t.id}/page`;
  const rest = await (await fetch(api, { headers: { cookie: memberCookie } })).json();
  assert.equal(rest.data.slug, t.slug);
  assert.equal(rest.data.statuses.one_pager, "published");
  assert.ok(rest.actions.some((a: { id: string; requires_human_confirmation: boolean }) => a.id === "finalize_in_browser" && a.requires_human_confirmation));
  const put = (body: unknown) => fetch(`${SITE}/api/v1/teams/${t.slug}/page`, { method: "PUT", headers: { cookie: organizerCookie, "content-type": "application/json", "idempotency-key": `${tag}-rest-1` }, body: JSON.stringify(body) });
  const p1 = await (await put({ commit_sha: SHA, expected_version: rest.data.page_version })).json();
  const p2 = await (await put({ commit_sha: SHA, expected_version: rest.data.page_version })).json();
  assert.equal(p1.data.receipt.id, p2.data.receipt.id);
  assert.equal(p2.data.replayed, true);
  const stale = await put({ commit_sha: "e".repeat(40), expected_version: 0, idempotency_key: `${tag}-rest-2` });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.details.current_version, p1.data.page_version);

  // MCP: team_page_get with a pairing bearer token defaults to the caller's team.
  await m.db.query("insert into member_tokens (member_id, kind, token_hash, expires_at) values ($1, 'bearer', $2, now() + interval '1 hour')", [t.members[0], createHash("sha256").update(token).digest("hex")]);
  const rpc = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_page_get", arguments: {} } }),
  });
  const env = JSON.parse((await rpc.json()).result.content[0].text);
  assert.equal(env.data.team_id, t.id);
  assert.equal(env.data.page_version, p1.data.page_version);
});
