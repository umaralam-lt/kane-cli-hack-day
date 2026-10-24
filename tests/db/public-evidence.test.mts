// Public evidence uploads against a *throwaway* database and a local S3 server (MinIO), same guard as tier0:
//   - request → presigned PUT → complete → an anonymous GET of the public URL serves the file with our headers
//   - incoming/ is never publicly readable, and S3 itself refuses a body that doesn't match the signed checksum
//   - dedupe and refresh on (project, sha256), idempotent completion, team scope, refused file types,
//     credential rejection, removal, the team quota, the submission lock, the kill switch and missing config
// An anonymous bucket policy on public/* stands in for CloudFront here. Real CloudFront and real S3 are not exercised.
//
//   QA_DATABASE_URL=postgres://…throwaway… QA_EVIDENCE_S3_ENDPOINT=http://127.0.0.1:9102 \
//   QA_EVIDENCE_S3_ACCESS_KEY_ID=… QA_EVIDENCE_S3_SECRET_ACCESS_KEY=… npm run test:db
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";

const QA = process.env.QA_DATABASE_URL;
const LIVE = process.env.DATABASE_URL;
const S3_URL = process.env.QA_EVIDENCE_S3_ENDPOINT;
const local = !!S3_URL && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(S3_URL);
const skip = !QA
  ? "QA_DATABASE_URL not set"
  : QA === LIVE
    ? "QA_DATABASE_URL equals DATABASE_URL: refusing to touch the live database"
    : !local
      ? "QA_EVIDENCE_S3_ENDPOINT must be a local S3 server (http://127.0.0.1:port)"
      : false;

type Caller = import("../../src/server/kane.ts").KaneCaller;
type Mods = {
  db: typeof import("../../src/lib/db.ts");
  flags: typeof import("../../src/lib/flags.ts");
  pe: typeof import("../../src/server/public-evidence.ts");
  up: typeof import("../../src/server/public-evidence-upload.ts");
};
let m: Mods;
let admin: S3Client;
const tag = `qa${Date.now().toString(36)}`;
const bucket = `qa-pe-${tag}`;
const ids = { teams: [] as number[], projects: [] as number[], members: [] as number[], staff: [] as number[], run: 0 };
const callers: Caller[] = [];
let organizer: Caller;
let mentor: Caller;
let loner: Caller;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = QA;
  process.env.SESSION_SECRET ||= "qa-session-secret-not-for-production";
  Object.assign(process.env, {
    EVIDENCE_S3_ENDPOINT: S3_URL,
    EVIDENCE_S3_REGION: "us-east-1",
    EVIDENCE_S3_BUCKET: bucket,
    EVIDENCE_CDN_BASE_URL: `${S3_URL!.replace(/\/$/, "")}/${bucket}`,
    EVIDENCE_S3_ACCESS_KEY_ID: process.env.QA_EVIDENCE_S3_ACCESS_KEY_ID,
    EVIDENCE_S3_SECRET_ACCESS_KEY: process.env.QA_EVIDENCE_S3_SECRET_ACCESS_KEY,
  });
  delete process.env.EVIDENCE_CDN_DISTRIBUTION_ID;
  const [db, flags, pe, up] = await Promise.all([
    import("../../src/lib/db.ts"),
    import("../../src/lib/flags.ts"),
    import("../../src/server/public-evidence.ts"),
    import("../../src/server/public-evidence-upload.ts"),
  ]);
  m = { db, flags, pe, up };
  admin = new S3Client({
    region: "us-east-1",
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY! },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/public/*`] }] };
  await admin.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));

  // Three teams of two, a member with no team, an organizer and a mentor.
  for (let t = 0; t < 3; t++) {
    const [team] = await db.query<{ id: number }>("insert into teams (slug, name, track, idea, password_hash) values ($1, $2, 'web', 'qa', 'x') returning id", [`${tag}-t${t}`, `${tag} team ${t}`]);
    ids.teams.push(team.id);
    const [p] = await db.query<{ id: number }>("insert into projects (team_id, name, slug) values ($1, $2, $3) returning id", [team.id, `${tag} project ${t}`, `${tag}-p${t}`]);
    ids.projects.push(p.id);
    for (let i = 0; i < 2; i++) callers.push({ kind: "member", member: await newMember(team.id, `${t}.${i}`) });
  }
  loner = { kind: "member", member: await newMember(null, "loner") };
  for (const role of ["organizer", "mentor"] as const) {
    const [s] = await db.query<{ id: number }>("insert into staff_accounts (email, name, role, active) values ($1, $2, $3, true) returning id", [`${tag}.${role}@example.test`, `QA ${role}`, role]);
    ids.staff.push(s.id);
    const staff: Caller = { kind: "staff", staff: { id: s.id, name: `QA ${role}`, email: null, role } };
    if (role === "organizer") organizer = staff;
    else mentor = staff;
  }
  const [run] = await db.query<{ id: number }>(
    "insert into kane_runs (project_id, team_id, source, upstream_execution_id, status, source_verified, verification_state) values ($1, $2, 'kanehack_cli', $3, 'passed', true, 'verified') returning id",
    [ids.projects[0], ids.teams[0], `${tag}-exec`],
  );
  ids.run = run.id;
});

after(async () => {
  if (skip || !m) return;
  await m.db.query("delete from settings where key = 'flag:public_evidence'").catch(() => {});
  await m.db.query("delete from teams where id = any($1::bigint[])", [ids.teams]).catch(() => {});
  await m.db.query("delete from members where id = any($1::bigint[])", [ids.members]).catch(() => {});
  await m.db.query("delete from staff_accounts where id = any($1::bigint[])", [ids.staff]).catch(() => {});
  await m.db.pool.end();
  const { Contents = [] } = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (Contents.length) await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map((o) => ({ Key: o.Key! })) } }));
  await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
});

async function newMember(teamId: number | null, label: string) {
  const [row] = await m.db.query<import("../../src/server/auth.ts").MemberRow>(
    `insert into members (team_id, name, email) values ($1, $2, $3)
     returning id, team_id, name, display_name, email, 'participant' as role, public_code, checked_in_at, activated_at, deleted_at`,
    [teamId, `QA ${label}`, `${tag}.${label}@example.test`],
  );
  ids.members.push(row.id);
  return row;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${tag}:${seed}`)]);
let keyN = 0;
const ask = (b: Buffer, extra: Record<string, unknown> = {}) => ({
  kind: "screenshot",
  filename: "home.png",
  content_type: "image/png",
  size_bytes: b.length,
  sha256: sha(b),
  participant_approved: true,
  idempotency_key: `${tag}-key-${++keyN}`,
  ...extra,
});
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
const put = (u: { url: string; headers: Record<string, string> }, body: Buffer) => fetch(u.url, { method: "PUT", body: new Uint8Array(body), headers: u.headers });

async function upload(c: Caller, body: Buffer, extra: Record<string, unknown> = {}) {
  const r = await m.up.requestPublicEvidenceUpload(c, ask(body, extra));
  assert.equal(r.status, "upload_required");
  if (r.status !== "upload_required") throw new Error("expected an upload");
  assert.equal((await put(r, body)).status, 200);
  return r;
}

test("request, PUT and complete publish the file at base + key with our headers", { skip }, async () => {
  const body = png("happy");
  const r = await upload(callers[0], body, { kane_execution_id: `${tag}-exec`, commit_sha: "b".repeat(40) });
  assert.equal(r.method, "PUT");
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["x-amz-checksum-sha256"], createHash("sha256").update(body).digest("base64"));
  assert.ok(new Date(r.expires_at).getTime() - Date.now() <= 600_000 + 5_000);

  // Uploaded but not yet checked: the incoming object is not public.
  const incoming = `${process.env.EVIDENCE_CDN_BASE_URL}/incoming/p${ids.projects[0]}/${sha(body)}.png`;
  assert.notEqual((await fetch(incoming)).status, 200);

  const done = await m.up.completePublicEvidenceUpload(callers[0], r.object_id);
  assert.equal(done.status, "public");
  assert.equal(done.public_url, `${process.env.EVIDENCE_CDN_BASE_URL}/public/p${ids.projects[0]}/${sha(body)}.png`);
  assert.equal(done.run_id, ids.run);
  assert.equal(done.commit_sha, "b".repeat(40));
  const res = await fetch(done.public_url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="home.png"');
  assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(body));

  // The incoming copy is gone, and the team page reader sees the object.
  await assert.rejects(admin.send(new HeadObjectCommand({ Bucket: bucket, Key: `incoming/p${ids.projects[0]}/${sha(body)}.png` })));
  const listed = await m.pe.listPublicEvidence(ids.projects[0]);
  assert.ok(listed.some((o) => o.id === done.object_id && o.url === done.public_url));
});

test("text kinds are served as plain UTF-8 text", { skip }, async () => {
  const body = Buffer.from(`# ${tag}\n<script>alert(1)</script>\n`);
  const r = await upload(callers[1], body, { kind: "report", filename: "summary.md", content_type: "text/markdown" });
  const done = await m.up.completePublicEvidenceUpload(callers[1], r.object_id);
  const res = await fetch(done.public_url);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(done.content_type, "text/plain; charset=utf-8");
});

test("S3 refuses a PUT whose body doesn't match the signed checksum", { skip }, async () => {
  const body = png("wrong-body");
  const r = await m.up.requestPublicEvidenceUpload(callers[0], ask(body));
  if (r.status !== "upload_required") throw new Error("expected an upload");
  const wrong = Buffer.from(body);
  wrong[wrong.length - 1] ^= 0xff;
  const bad = await put(r, wrong);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /XAmzContentChecksumMismatch|BadDigest/);
  assert.equal((await fetch(r.url, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": "image/png" } })).status >= 400, true);
  await assert.rejects(m.up.completePublicEvidenceUpload(callers[0], r.object_id), (e: { code?: string; details?: { reason?: string } }) => e.code === "NOT_FOUND" && e.details?.reason === "upload_missing");
  assert.equal((await put(r, body)).status, 200);
  assert.equal((await m.up.completePublicEvidenceUpload(callers[0], r.object_id)).status, "public");
});

test("the same sha256 refreshes a pending upload, then returns the public object, and completion is idempotent", { skip }, async () => {
  const body = png("dedupe");
  const firstAsk = ask(body);
  const a = await m.up.requestPublicEvidenceUpload(callers[0], firstAsk);
  const replay = await m.up.requestPublicEvidenceUpload(callers[0], firstAsk);
  assert.deepEqual(replay, a);
  const b = await m.up.requestPublicEvidenceUpload(callers[1], ask(body, { filename: "renamed.png" }));
  assert.equal(b.object_id, a.object_id);
  assert.equal(b.status, "upload_required");
  if (b.status !== "upload_required") throw new Error("expected an upload");
  assert.equal((await put(b, body)).status, 200);
  const first = await m.up.completePublicEvidenceUpload(callers[1], b.object_id);
  const again = await m.up.completePublicEvidenceUpload(callers[0], b.object_id);
  assert.deepEqual(again, first);
  const exists = await m.up.requestPublicEvidenceUpload(callers[0], ask(body));
  assert.equal(exists.status, "exists");
  if (exists.status !== "exists") throw new Error("expected exists");
  assert.equal(exists.public_url, first.public_url);
  assert.equal(exists.object_id, first.object_id);
  const [{ n }] = await m.db.query<{ n: number }>("select count(*)::int as n from public_evidence where project_id = $1 and sha256 = $2", [ids.projects[0], sha(body)]);
  assert.equal(n, 1);
});

test("only the team's own members can upload, complete, read or remove", { skip }, async () => {
  const body = png("scope");
  const r = await upload(callers[0], body);
  await assert.rejects(m.up.completePublicEvidenceUpload(callers[2], r.object_id), code("NOT_FOUND"));
  await assert.rejects(m.up.getPublicEvidenceObject(callers[2], r.object_id), code("NOT_FOUND"));
  await assert.rejects(m.up.removePublicEvidence(callers[2], r.object_id, {}), code("NOT_FOUND"));
  await assert.rejects(m.up.requestPublicEvidenceUpload(callers[2], ask(png("other"), { project_id: ids.projects[0] })), code("FORBIDDEN"));
  await assert.rejects(m.up.requestPublicEvidenceUpload(loner, ask(png("loner"))), code("FORBIDDEN"));
  await assert.rejects(m.up.requestPublicEvidenceUpload(organizer, ask(png("staff"))), code("FORBIDDEN"));
  await assert.rejects(m.up.requestPublicEvidenceUpload(callers[0], ask(png("run"), { run_id: 999_999_999 })), code("NOT_FOUND"));
  await assert.rejects(m.up.requestPublicEvidenceUpload(callers[0], ask(png("approve"), { participant_approved: false })), code("VALIDATION_FAILED"));
  assert.equal((await m.up.getPublicEvidenceObject(mentor, r.object_id)).status, "pending");
  const listed = await m.up.listPublicEvidenceObjects(organizer, ids.projects[0]);
  assert.ok(listed.objects.some((o) => o.object_id === r.object_id));
});

test("packs, HAR and HTML are refused before any upload URL exists", { skip }, async () => {
  for (const [filename, content_type] of [["run.evidence", "application/zip"], ["network.har", "application/json"], ["page.html", "text/html"], ["page.svg", "image/svg+xml"], ["report.pdf", "application/pdf"]]) {
    await assert.rejects(m.up.requestPublicEvidenceUpload(callers[1], ask(Buffer.from(filename), { kind: "report", filename, content_type })), code("VALIDATION_FAILED"), filename);
  }
  const [{ n }] = await m.db.query<{ n: number }>("select count(*)::int as n from public_evidence where original_name in ('run.evidence', 'network.har', 'page.html')");
  assert.equal(n, 0);
});

test("a credential in NDJSON rejects those bytes for good and nothing is published", { skip }, async () => {
  const body = Buffer.from(['{"type":"run_start","objective":"login"}', `{"type":"step","password":"${tag}-hunter2"}`, '{"type":"run_end","status":"passed"}'].join("\n"));
  const r = await upload(callers[1], body, { kind: "ndjson", filename: "run.ndjson", content_type: "application/x-ndjson" });
  await assert.rejects(m.up.completePublicEvidenceUpload(callers[1], r.object_id), (e: { code?: string; details?: { status?: string; fields?: string[] } }) => {
    return e.code === "VALIDATION_FAILED" && e.details?.status === "rejected" && !!e.details.fields?.includes("line 2: password");
  });
  const o = await m.up.getPublicEvidenceObject(callers[1], r.object_id);
  assert.equal(o.status, "rejected");
  assert.match(o.reject_reason ?? "", /credential/);
  assert.equal(o.public_url, null);
  await assert.rejects(admin.send(new HeadObjectCommand({ Bucket: bucket, Key: `incoming/p${ids.projects[0]}/${sha(body)}.ndjson` })));
  assert.notEqual((await fetch(`${process.env.EVIDENCE_CDN_BASE_URL}/public/p${ids.projects[0]}/${sha(body)}.ndjson`)).status, 200);
  await assert.rejects(m.up.requestPublicEvidenceUpload(callers[1], ask(body, { kind: "ndjson", filename: "run.ndjson", content_type: "application/x-ndjson" })), code("VALIDATION_FAILED"));
});

test("remove makes the object unreadable, and the same file can be published again", { skip }, async () => {
  const body = png("remove");
  const r = await upload(callers[0], body);
  const done = await m.up.completePublicEvidenceUpload(callers[0], r.object_id);
  assert.equal((await fetch(done.public_url)).status, 200);
  const removed = await m.up.removePublicEvidence(callers[1], r.object_id, { reason: "published by mistake" });
  assert.equal(removed.status, "removed");
  assert.equal(removed.cache_invalidation, "not_configured");
  assert.notEqual((await fetch(done.public_url)).status, 200);
  assert.deepEqual((await m.up.removePublicEvidence(callers[1], r.object_id, {})).object_id, r.object_id);
  assert.ok(!(await m.pe.listPublicEvidence(ids.projects[0])).some((o) => o.id === r.object_id));
  await assert.rejects(m.up.completePublicEvidenceUpload(callers[0], r.object_id), code("CONFLICT"));
  const again = await upload(callers[0], body);
  assert.equal(again.object_id, r.object_id);
  assert.equal((await m.up.completePublicEvidenceUpload(callers[0], again.object_id)).public_url, done.public_url);
  await assert.rejects(m.up.removePublicEvidence(mentor, r.object_id, {}), code("FORBIDDEN"));
});

test("the team quota counts public objects", { skip }, async () => {
  const pid = ids.projects[2];
  await m.db.query(
    `insert into public_evidence (project_id, kind, sha256, size_bytes, content_type, original_name, object_key, status, completed_at)
     select $1, 'log', encode(sha256(convert_to($2 || g::text, 'UTF8')), 'hex'), 10, 'text/plain; charset=utf-8', 'x.log', $3 || g::text || '.log', 'public', now()
       from generate_series(1, 200) g`,
    [pid, tag, `public/p${pid}/`],
  );
  await assert.rejects(m.up.requestPublicEvidenceUpload(callers[4], ask(png("quota"))), (e: { code?: string; details?: { reason?: string } }) => e.code === "VALIDATION_FAILED" && e.details?.reason === "team_quota");
});

test("after the submission lock members can't upload or remove but organizers can still remove", { skip }, async () => {
  const body = png("lock");
  const r = await upload(callers[0], body);
  const done = await m.up.completePublicEvidenceUpload(callers[0], r.object_id);
  const pending = await upload(callers[0], png("lock-pending"));
  const [ev] = await m.db.query<{ locks: Date }>("select submission_locks_at as locks from hack_events where id = current_event_id()");
  await m.db.query("update hack_events set submission_locks_at = now() - interval '1 minute' where id = current_event_id()");
  try {
    await assert.rejects(m.up.requestPublicEvidenceUpload(callers[0], ask(png("late"))), code("SUBMISSION_LOCKED"));
    await assert.rejects(m.up.completePublicEvidenceUpload(callers[0], pending.object_id), code("SUBMISSION_LOCKED"));
    await assert.rejects(m.up.removePublicEvidence(callers[0], r.object_id, {}), code("SUBMISSION_LOCKED"));
    assert.equal((await m.up.completePublicEvidenceUpload(callers[0], r.object_id)).status, "public");
    assert.equal((await m.up.removePublicEvidence(organizer, r.object_id, { reason: "organizer takedown" })).status, "removed");
    assert.notEqual((await fetch(done.public_url)).status, 200);
  } finally {
    await m.db.query("update hack_events set submission_locks_at = $1 where id = current_event_id()", [ev.locks]);
  }
});

test("the kill switch and missing config refuse uploads cleanly", { skip }, async () => {
  await m.flags.setFlag("public_evidence", false);
  try {
    await assert.rejects(m.up.requestPublicEvidenceUpload(callers[3], ask(png("flag"))), code("FEATURE_DISABLED"));
  } finally {
    await m.flags.setFlag("public_evidence", true);
  }
  const saved = process.env.EVIDENCE_S3_BUCKET;
  delete process.env.EVIDENCE_S3_BUCKET;
  try {
    await assert.rejects(m.up.requestPublicEvidenceUpload(callers[3], ask(png("config"))), (e: { code?: string; details?: { missing?: string[] } }) => e.code === "DOWNSTREAM_DEGRADED" && !!e.details?.missing?.includes("EVIDENCE_S3_BUCKET"));
  } finally {
    process.env.EVIDENCE_S3_BUCKET = saved;
  }
});
