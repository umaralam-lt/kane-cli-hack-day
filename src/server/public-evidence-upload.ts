import "server-only";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import { requireFlag } from "@/lib/flags";
import { hasRole, type MemberRow } from "./auth";
import { AppError, idempotent, parse, withAudit, z, zx, type Receipt, type toEnvelope } from "./core";
import { callerActor, callerMember, projectFor, type KaneCaller, type ProjectRef } from "./kane";
import { extOf } from "./kane-evidence";
import { log } from "./log";
import { enforceRateLimit } from "./ratelimit";
import { PUBLIC_EVIDENCE_KINDS, parsePublicEvidenceId, publicEvidenceId, publicEvidenceUrl, type PublicEvidenceKind, type PublicEvidenceStatus } from "./public-evidence";
import {
  MAX_TEAM_BYTES,
  MAX_TEAM_OBJECTS,
  PUBLIC_CACHE_CONTROL,
  UPLOAD_URL_TTL_SEC,
  checkPublicFile,
  checksumBase64,
  dispositionName,
  incomingKey,
  inspectPublicBytes,
  publicKey,
  sha256Hex,
  type PublicFileCheck,
} from "./public-evidence-rules";

// Public evidence uploads to S3 (docs/api/PUBLIC_EVIDENCE.md): request a presigned PUT, check the bytes, publish, remove.

const RATE = { limit: 60, windowSec: 60 };
const REQUIRED_ENV = ["EVIDENCE_S3_BUCKET", "EVIDENCE_S3_REGION", "EVIDENCE_CDN_BASE_URL", "EVIDENCE_S3_ACCESS_KEY_ID", "EVIDENCE_S3_SECRET_ACCESS_KEY"] as const;
const ENDPOINT_ENV = "EVIDENCE_S3_ENDPOINT";
const DISTRIBUTION_ENV = "EVIDENCE_CDN_DISTRIBUTION_ID";
const CLOUDFRONT_REGION = "us-east-1";
const MAX_REASON = 500;
const LIST_LIMIT = 500;
const ROW_COLS = `id, project_id, kind, sha256, size_bytes, content_type, original_name, object_key, status, reject_reason, run_id, commit_sha, uploaded_by, url_expires_at,
  created_at, completed_at, removed_at`;

const runRef = z.preprocess((v) => (typeof v === "string" ? v.trim().replace(/^KR-/i, "") : v), zx.id);

export const requestUploadSchema = z
  .object({
    project_id: zx.id.optional(),
    kind: z.enum(PUBLIC_EVIDENCE_KINDS),
    filename: z.string().trim().min(1).max(200),
    content_type: z.string().trim().min(1).max(120),
    size_bytes: z.coerce.number().int().positive(),
    sha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "Must be the 64-character hex sha256 of the file"),
    run_id: runRef.optional(),
    kane_execution_id: z.string().trim().min(1).max(120).optional(),
    commit_sha: zx.commitSha.optional(),
    participant_approved: z.literal(true, { error: "The participant must approve publishing this file (participant_approved: true)." }),
    idempotency_key: z.string().trim().min(8).max(200),
  })
  .refine((v) => !(v.run_id && v.kane_execution_id), { message: "Send run_id or kane_execution_id, not both.", path: ["run_id"] });

export const removeSchema = z.object({ reason: zx.optText(300) });

/** Issue a presigned PUT for one participant-approved file, deduped on (team project, sha256). */
export async function requestPublicEvidenceUpload(c: KaneCaller, raw: unknown, opts: { requestId?: string } = {}): Promise<PublicEvidenceUploadResult> {
  await requireFlag("public_evidence");
  const input = parse(requestUploadSchema, raw);
  if (c.kind === "staff") throw new AppError("FORBIDDEN", { userMessage: "Staff can't publish evidence for a team. A team member uploads it." });
  const project = await projectFor(c, input.project_id);
  const member = callerMember(c)!;
  const file = checkPublicFile({ kind: input.kind, filename: input.filename, contentType: input.content_type, sizeBytes: input.size_bytes });
  if (!file.ok) throw new AppError("VALIDATION_FAILED", { userMessage: file.reason, details: { reason: "file_refused" } });
  await assertNotLocked();
  await enforceRateLimitFor(member);
  const s3 = requireS3();
  const runId = await resolveRun(project.id, input);
  const { result } = await idempotent(input.idempotency_key, `public_evidence.request:project:${project.id}`, () => issueUpload(c, member, project, input, file, runId, s3, opts.requestId));
  return result;
}

/** Check the uploaded bytes and publish them, or reject them for good. Completing a public object returns its receipt. */
export async function completePublicEvidenceUpload(c: KaneCaller, ref: string, opts: { requestId?: string } = {}): Promise<PublicEvidenceReceipt> {
  await requireFlag("public_evidence");
  const id = refId(ref);
  if (c.kind === "staff") throw new AppError("FORBIDDEN", { userMessage: "Staff can't publish evidence for a team." });
  const project = await projectFor(c);
  const member = callerMember(c)!;
  const row = await rowById(id);
  if (!row || row.project_id !== project.id) throw new AppError("NOT_FOUND");
  const s3 = requireS3();
  if (row.status === "public") return receiptOf(row, "public");
  if (row.status === "rejected") throw rejectedError(row);
  if (row.status === "removed") throw new AppError("CONFLICT", { userMessage: `${publicEvidenceId(row.id)} was removed. Request a new upload to publish it again.`, details: { object_id: publicEvidenceId(row.id), status: row.status } });
  await assertNotLocked();
  await enforceRateLimitFor(member);
  const incoming = incomingKey(row.project_id, row.sha256, extOf(row.object_key));
  const bytes = await fetchIncoming(s3, row, incoming);
  const verdict = inspectPublicBytes({ kind: row.kind, filename: row.original_name, bytes });
  if (!verdict.ok) throw await rejectRow(c, row, incoming, verdict.reason, verdict.fields ?? [], s3, opts.requestId);
  return publishRow(c, row, incoming, s3, opts.requestId);
}

/** Every public evidence object of a project, any status, newest first: the team, or staff with project_id. */
export async function listPublicEvidenceObjects(c: KaneCaller, projectId?: number | null) {
  const project = await projectFor(c, projectId, { read: true });
  const rows = await query<Row>(`select ${ROW_COLS} from public_evidence where project_id = $1 order by created_at desc limit ${LIST_LIMIT}`, [project.id]);
  return { project, objects: rows.map(objectView) };
}

/** One object by PE-n. Another team's object is NOT_FOUND. */
export async function getPublicEvidenceObject(c: KaneCaller, ref: string) {
  const row = await rowById(refId(ref));
  if (!row) throw new AppError("NOT_FOUND");
  await projectFor(c, row.project_id, { read: true }).catch((err) => {
    throw err instanceof AppError && err.code === "FORBIDDEN" ? new AppError("NOT_FOUND") : err;
  });
  return objectView(row);
}

/** Unpublish an object: a team member before the submission lock, or an organizer at any time. */
export async function removePublicEvidence(c: KaneCaller, ref: string, raw: unknown, opts: { requestId?: string } = {}): Promise<PublicEvidenceRemoval> {
  const input = parse(removeSchema, raw ?? {});
  const row = await rowById(refId(ref));
  if (!row) throw new AppError("NOT_FOUND");
  const organizer = c.kind === "staff" && hasRole(c.staff, "organizer");
  if (c.kind === "staff" && !organizer) throw new AppError("FORBIDDEN", { userMessage: "Only the team or an organizer can remove public evidence." });
  if (!organizer) {
    const project = await projectFor(c);
    if (project.id !== row.project_id) throw new AppError("NOT_FOUND");
    await assertNotLocked("An organizer can still remove it.");
  }
  const s3 = requireS3();
  const removed = await withAudit<Row>(
    callerActor(c),
    "public_evidence.remove",
    "public_evidence",
    async (tx) => {
      const { rows } = await tx.query<Row>(`select ${ROW_COLS} from public_evidence where id = $1 for update`, [row.id]);
      const cur = rows[0];
      if (!cur) throw new AppError("NOT_FOUND");
      if (cur.status === "rejected") throw new AppError("CONFLICT", { userMessage: `${publicEvidenceId(cur.id)} was rejected and never published, so there's nothing to remove.`, details: { object_id: publicEvidenceId(cur.id), status: cur.status } });
      if (cur.status === "removed") return { result: cur, resourceId: cur.id, reason: "already removed" };
      const { rows: after } = await tx.query<Row>(`update public_evidence set status = 'removed', removed_at = now() where id = $1 returning ${ROW_COLS}`, [cur.id]);
      return { result: after[0], resourceId: cur.id, before: { status: cur.status }, after: { status: "removed" }, reason: input.reason };
    },
    { requestId: opts.requestId },
  );
  await deleteObject(s3, removed.object_key);
  await discard(s3, incomingKey(removed.project_id, removed.sha256, extOf(removed.object_key)));
  const cache = removed.completed_at ? await invalidateEdge(s3, removed.object_key) : "not_needed";
  return {
    object_id: publicEvidenceId(removed.id),
    status: "removed",
    removed_at: removed.removed_at!.toISOString(),
    cache_invalidation: cache,
    receipt: { id: publicEvidenceId(removed.id), server_time: removed.removed_at!.toISOString() },
  };
}

// ── Envelopes (REST and MCP) ─────────────────────────────────────────────────

export function uploadEnvelope(r: PublicEvidenceUploadResult): Env {
  if (r.status !== "upload_required") return receiptEnvelope(r);
  return {
    status: "needs_action",
    message: `PUT the file to the upload URL with exactly these headers before ${r.expires_at}, then complete ${r.object_id}.`,
    data: r,
    actions: [{ id: "complete_upload", label: `Complete ${r.object_id} after the PUT`, requires_human_confirmation: false, tool: "public_evidence_complete" }],
    uiType: "kane_run",
    fallbackText: `${r.object_id}: PUT ${r.size_bytes} bytes to the upload URL (expires ${r.expires_at}), then POST /api/v1/evidence/public/uploads/${r.object_id}/complete.`,
  };
}

export function receiptEnvelope(r: PublicEvidenceReceipt): Env {
  return {
    message: r.status === "exists" ? `${r.object_id} is already public (same sha256): ${r.public_url}` : `${r.object_id} is public: ${r.public_url}`,
    data: r,
    evidence: [{ kind: "public_evidence", id: r.object_id, confidence: "participant_reported", url: r.public_url }],
    uiType: "kane_run",
    fallbackText: `${r.object_id} PUBLIC ${r.public_url} sha256:${r.sha256}`,
  };
}

export function objectsEnvelope(objects: PublicEvidenceObject[]): Env {
  const live = objects.filter((o) => o.status === "public");
  return {
    message: `${objects.length} public evidence object(s), ${live.length} public.`,
    data: { objects },
    uiType: "kane_run",
    fallbackText: objects.map((o) => `${o.object_id} ${o.status.toUpperCase()} ${o.kind} ${o.public_url ?? o.reject_reason ?? ""}`.trim()).join("\n") || "No public evidence yet.",
  };
}

export function objectEnvelope(o: PublicEvidenceObject): Env {
  return {
    message: `${o.object_id} is ${o.status}.${o.reject_reason ? ` ${o.reject_reason}` : ""}`,
    data: o,
    uiType: "kane_run",
    fallbackText: `${o.object_id} ${o.status.toUpperCase()} ${o.public_url ?? o.reject_reason ?? ""}`.trim(),
  };
}

export function removalEnvelope(r: PublicEvidenceRemoval): Env {
  const cached = r.cache_invalidation === "not_configured" || r.cache_invalidation === "failed";
  return {
    message: `${r.object_id} was removed from the public bucket.`,
    data: r,
    warnings: cached ? ["CloudFront may keep serving a cached copy until an organizer invalidates this path."] : [],
    uiType: "kane_run",
    fallbackText: `${r.object_id} REMOVED at ${r.removed_at}${cached ? " (CDN cache not invalidated)" : ""}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function issueUpload(c: KaneCaller, member: MemberRow, project: ProjectRef, input: RequestInput, file: Extract<PublicFileCheck, { ok: true }>, runId: number | null, s3: S3, requestId?: string) {
  return withAudit<PublicEvidenceUploadResult>(
    callerActor(c),
    "public_evidence.request",
    "public_evidence",
    async (tx) => {
      await lockProject(tx, project.id);
      const { rows } = await tx.query<Row>(`select ${ROW_COLS} from public_evidence where project_id = $1 and sha256 = $2 for update`, [project.id, input.sha256]);
      const prior = rows[0];
      if (prior?.status === "public") return { result: receiptOf(prior, "exists"), resourceId: prior.id, reason: "duplicate" };
      if (prior?.status === "rejected") throw rejectedError(prior);
      await assertQuota(tx, project.id, input.sha256, input.size_bytes, true);
      const signedAt = new Date();
      const expiresAt = new Date(signedAt.getTime() + UPLOAD_URL_TTL_SEC * 1000);
      const values = [file.servedContentType, input.kind, input.size_bytes, input.filename, publicKey(project.id, input.sha256, file.ext), runId, input.commit_sha ?? null, member.id, expiresAt];
      const { rows: saved } = prior
        ? await tx.query<Row>(
            `update public_evidence set content_type = $1, kind = $2, size_bytes = $3, original_name = $4, object_key = $5, run_id = coalesce($6, run_id),
                    commit_sha = coalesce($7, commit_sha), uploaded_by = case when status = 'removed' then $8 else uploaded_by end, url_expires_at = $9,
                    status = 'pending', reject_reason = null, completed_at = null, removed_at = null
              where id = $10 returning ${ROW_COLS}`,
            [...values, prior.id],
          )
        : await tx.query<Row>(
            `insert into public_evidence (content_type, kind, size_bytes, original_name, object_key, run_id, commit_sha, uploaded_by, url_expires_at, project_id, sha256)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${ROW_COLS}`,
            [...values, project.id, input.sha256],
          );
      const row = saved[0];
      const checksum = checksumBase64(row.sha256);
      const url = await getSignedUrl(
        s3.client,
        new PutObjectCommand({ Bucket: s3.bucket, Key: incomingKey(project.id, row.sha256, file.ext), ContentType: file.uploadContentType, ContentLength: row.size_bytes, ChecksumSHA256: checksum }),
        { expiresIn: UPLOAD_URL_TTL_SEC, signingDate: signedAt, unhoistableHeaders: new Set(["x-amz-checksum-sha256"]), signableHeaders: new Set(["content-type", "content-length"]) },
      );
      const result: PublicEvidenceUpload = {
        object_id: publicEvidenceId(row.id),
        status: "upload_required",
        method: "PUT",
        url,
        headers: { "content-type": file.uploadContentType, "x-amz-checksum-sha256": checksum },
        expires_at: expiresAt.toISOString(),
        max_bytes: file.maxBytes,
        kind: row.kind,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        receipt: { id: publicEvidenceId(row.id), server_time: signedAt.toISOString() },
      };
      return { result, resourceId: row.id, before: prior ? { status: prior.status } : undefined, after: { status: "pending", kind: row.kind, sha256: row.sha256 }, payload: { project_id: project.id } };
    },
    { requestId },
  );
}

/** HEAD with the stored checksum, then GET and re-hash. A mismatch deletes the upload and leaves the object pending. */
async function fetchIncoming(s3: S3, row: Row, key: string): Promise<Buffer> {
  const head = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key, ChecksumMode: "ENABLED" })).catch((err) => {
    throw isMissing(err) ? uploadMissing(row) : degraded(err, "head");
  });
  if (head.ContentLength !== row.size_bytes || head.ChecksumSHA256 !== checksumBase64(row.sha256)) throw await mismatch(s3, row, key);
  const got = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key })).catch((err) => {
    throw isMissing(err) ? uploadMissing(row) : degraded(err, "get");
  });
  const bytes = Buffer.from((await got.Body?.transformToByteArray()) ?? []);
  if (bytes.length !== row.size_bytes || sha256Hex(bytes) !== row.sha256) throw await mismatch(s3, row, key);
  return bytes;
}

async function publishRow(c: KaneCaller, row: Row, incoming: string, s3: S3, requestId?: string): Promise<PublicEvidenceReceipt> {
  let copied = false;
  try {
    const receipt = await withAudit<PublicEvidenceReceipt>(
      callerActor(c),
      "public_evidence.complete",
      "public_evidence",
      async (tx) => {
        await lockProject(tx, row.project_id);
        const { rows } = await tx.query<Row>(`select ${ROW_COLS} from public_evidence where id = $1 for update`, [row.id]);
        const cur = rows[0];
        if (cur?.status === "public") return { result: receiptOf(cur, "public"), resourceId: cur.id, reason: "already public" };
        if (!cur || cur.status !== "pending" || cur.object_key !== row.object_key) throw new AppError("CONFLICT", { userMessage: "This upload changed while it was being checked. Call complete again." });
        await assertQuota(tx, cur.project_id, cur.sha256, cur.size_bytes, false);
        await copyToPublic(s3, incoming, cur);
        copied = true;
        const { rows: after } = await tx.query<Row>(`update public_evidence set status = 'public', completed_at = now(), reject_reason = null where id = $1 returning ${ROW_COLS}`, [cur.id]);
        return { result: receiptOf(after[0], "public"), resourceId: cur.id, before: { status: "pending" }, after: { status: "public", object_key: cur.object_key } };
      },
      { requestId },
    );
    await discard(s3, incoming);
    return receipt;
  } catch (err) {
    if (copied) await discard(s3, row.object_key);
    throw err;
  }
}

/** Delete the upload and record why these bytes can never be published. Returns the error to throw. */
async function rejectRow(c: KaneCaller, row: Row, incoming: string, reason: string, fields: string[], s3: S3, requestId?: string) {
  await discard(s3, incoming);
  const why = reason.slice(0, MAX_REASON);
  await withAudit(
    callerActor(c),
    "public_evidence.reject",
    "public_evidence",
    async (tx) => {
      await tx.query("update public_evidence set status = 'rejected', reject_reason = $2 where id = $1 and status = 'pending'", [row.id, why]);
      return { result: null, resourceId: row.id, before: { status: "pending" }, after: { status: "rejected" }, reason: why };
    },
    { requestId },
  );
  return new AppError("VALIDATION_FAILED", { userMessage: why, details: { object_id: publicEvidenceId(row.id), status: "rejected", reason: why, fields } });
}

async function copyToPublic(s3: S3, incoming: string, row: Row) {
  await s3.client
    .send(
      new CopyObjectCommand({
        Bucket: s3.bucket,
        Key: row.object_key,
        CopySource: encodeURI(`${s3.bucket}/${incoming}`),
        MetadataDirective: "REPLACE",
        ContentType: row.content_type,
        CacheControl: PUBLIC_CACHE_CONTROL,
        ContentDisposition: `inline; filename="${dispositionName(row.original_name)}"`,
      }),
    )
    .catch((err) => {
      throw degraded(err, "copy");
    });
}

async function deleteObject(s3: S3, key: string) {
  await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key })).catch((err) => {
    throw new AppError("DOWNSTREAM_DEGRADED", { userMessage: "It's marked removed, but the file couldn't be deleted from storage yet. Call remove again in a minute.", details: { op: "delete", name: (err as Error)?.name } });
  });
}

/** Best-effort delete: a leftover incoming object expires with the bucket's lifecycle rule. */
async function discard(s3: S3, key: string) {
  await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key })).catch((err) => log.warn("public_evidence.discard_failed", { key, err }));
}

/** Ask CloudFront to drop cached copies, when EVIDENCE_CDN_DISTRIBUTION_ID is set. */
async function invalidateEdge(s3: S3, objectKey: string): Promise<PublicEvidenceRemoval["cache_invalidation"]> {
  const distribution = process.env[DISTRIBUTION_ENV]?.trim();
  if (!distribution) return "not_configured";
  try {
    await s3.cloudfront().send(
      new CreateInvalidationCommand({ DistributionId: distribution, InvalidationBatch: { CallerReference: `${objectKey}:${Date.now()}`, Paths: { Quantity: 1, Items: [`/${objectKey}`] } } }),
    );
    return "invalidated";
  } catch (err) {
    log.warn("public_evidence.invalidation_failed", { key: objectKey, err });
    return "failed";
  }
}

async function assertNotLocked(hint?: string) {
  const [row] = await query<{ now: Date; locks_at: Date | null; locked: boolean }>(
    "select now() as now, submission_locks_at as locks_at, coalesce(now() >= submission_locks_at, false) as locked from hack_events where id = current_event_id()",
  );
  if (!row?.locked) return;
  throw new AppError("SUBMISSION_LOCKED", {
    userMessage: `Submissions locked at ${row.locks_at!.toISOString()} (server time), so public evidence can't change now.${hint ? ` ${hint}` : ""}`,
    details: { locks_at: row.locks_at!.toISOString(), server_time: row.now.toISOString() },
  });
}

const enforceRateLimitFor = (member: MemberRow) => enforceRateLimit(`public-evidence:${member.id}`, RATE);

/** Serialise uploads per project so the team quota can't be raced. */
const lockProject = (tx: PoolClient, projectId: number) => tx.query("select pg_advisory_xact_lock(hashtext('public_evidence:' || $1))", [String(projectId)]);

/** Team quota: public objects plus uploads still in flight (at request time), excluding this sha256. */
async function assertQuota(tx: PoolClient, projectId: number, sha256: string, sizeBytes: number, includeInFlight: boolean) {
  const { rows } = await tx.query<{ n: number; bytes: number }>(
    `select count(*)::int as n, coalesce(sum(size_bytes), 0)::bigint as bytes from public_evidence
      where project_id = $1 and sha256 <> $2 and (status = 'public' or ($3 and status = 'pending' and url_expires_at > now()))`,
    [projectId, sha256, includeInFlight],
  );
  const { n, bytes } = rows[0];
  if (n + 1 <= MAX_TEAM_OBJECTS && bytes + sizeBytes <= MAX_TEAM_BYTES) return;
  throw new AppError("VALIDATION_FAILED", {
    userMessage: `Your team can publish at most ${MAX_TEAM_OBJECTS} files and ${MAX_TEAM_BYTES / 1024 / 1024 / 1024} GB of public evidence. Remove some first.`,
    details: { reason: "team_quota", max_objects: MAX_TEAM_OBJECTS, max_bytes: MAX_TEAM_BYTES, used_objects: n, used_bytes: bytes },
  });
}

async function resolveRun(projectId: number, input: RequestInput): Promise<number | null> {
  if (input.run_id) {
    const [r] = await query<{ id: number }>("select id from kane_runs where id = $1 and project_id = $2", [input.run_id, projectId]);
    if (!r) throw new AppError("NOT_FOUND", { userMessage: "That run isn't in your project." });
    return r.id;
  }
  if (input.kane_execution_id) {
    const [r] = await query<{ id: number }>("select id from kane_runs where project_id = $1 and upstream_execution_id = $2 order by received_at desc limit 1", [projectId, input.kane_execution_id]);
    if (!r) throw new AppError("NOT_FOUND", { userMessage: "No Kane run with that execution id is in your project. Report it first (kane_record_run)." });
    return r.id;
  }
  return null;
}

async function rowById(id: number) {
  const [row] = await query<Row>(`select ${ROW_COLS} from public_evidence where id = $1`, [id]);
  return row ?? null;
}

function refId(ref: string) {
  const id = parsePublicEvidenceId(ref);
  if (!id) throw new AppError("NOT_FOUND");
  return id;
}

/** The public URL, or null when EVIDENCE_CDN_BASE_URL is unset. */
function urlOf(objectKey: string) {
  try {
    return publicEvidenceUrl(objectKey);
  } catch {
    return null;
  }
}

function receiptOf(row: Row, status: PublicEvidenceReceipt["status"]): PublicEvidenceReceipt {
  return {
    object_id: publicEvidenceId(row.id),
    status,
    public_url: publicEvidenceUrl(row.object_key),
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    kind: row.kind,
    run_id: row.run_id,
    commit_sha: row.commit_sha,
    receipt: { id: publicEvidenceId(row.id), server_time: row.completed_at!.toISOString() },
  };
}

function objectView(row: Row): PublicEvidenceObject {
  return {
    object_id: publicEvidenceId(row.id),
    kind: row.kind,
    status: row.status,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    filename: row.original_name,
    public_url: row.status === "public" ? urlOf(row.object_key) : null,
    run_id: row.run_id,
    commit_sha: row.commit_sha,
    reject_reason: row.reject_reason,
    upload_expires_at: row.status === "pending" && row.url_expires_at ? row.url_expires_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    removed_at: row.removed_at?.toISOString() ?? null,
  };
}

function rejectedError(row: Row) {
  const id = publicEvidenceId(row.id);
  return new AppError("VALIDATION_FAILED", {
    userMessage: `${id} was rejected: ${row.reject_reason ?? "it failed the public evidence checks."} Fix the file: the new version gets a new sha256.`,
    details: { object_id: id, status: "rejected", reason: row.reject_reason },
  });
}

function uploadMissing(row: Row) {
  return new AppError("NOT_FOUND", {
    userMessage: `The upload for ${publicEvidenceId(row.id)} hasn't arrived. PUT the file first. If the URL expired, request the upload again for a fresh one.`,
    details: { object_id: publicEvidenceId(row.id), status: "pending", reason: "upload_missing" },
  });
}

async function mismatch(s3: S3, row: Row, key: string) {
  await discard(s3, key);
  return new AppError("VALIDATION_FAILED", {
    userMessage: `The uploaded bytes for ${publicEvidenceId(row.id)} don't match the size and sha256 you declared. Request the upload again and PUT the exact file.`,
    details: { object_id: publicEvidenceId(row.id), status: "pending", reason: "digest_mismatch" },
  });
}

function degraded(err: unknown, op: string) {
  log.warn("public_evidence.s3_failed", { op, err, status: (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? null });
  return new AppError("DOWNSTREAM_DEGRADED", { userMessage: "Public evidence storage is unavailable right now. Keep the file and try again in a minute.", details: { op } });
}

/** A missing key is 404 with s3:ListBucket, or 403 without it. */
function isMissing(err: unknown) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 404 || e?.$metadata?.httpStatusCode === 403 || e?.name === "NotFound" || e?.name === "NoSuchKey";
}

let cachedS3: { key: string; s3: S3 } | null = null;

/** The S3 client from the EVIDENCE_S3_* and EVIDENCE_CDN_* env, or DOWNSTREAM_DEGRADED when it isn't configured. */
function requireS3(): S3 {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new AppError("DOWNSTREAM_DEGRADED", { userMessage: "Public evidence isn't configured on this server yet. Keep the files and manifest locally with upload=pending.", details: { reason: "not_configured", missing } });
  }
  const [bucket, region, , accessKeyId, secretAccessKey] = REQUIRED_ENV.map((name) => process.env[name]!.trim());
  const endpoint = process.env[ENDPOINT_ENV]?.trim() || undefined;
  const key = [bucket, region, accessKeyId, secretAccessKey, endpoint].join("|");
  if (cachedS3?.key === key) return cachedS3.s3;
  const credentials = { accessKeyId, secretAccessKey };
  const client = new S3Client({ region, credentials, endpoint, forcePathStyle: !!endpoint, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  let cf: CloudFrontClient | null = null;
  const s3: S3 = { client, bucket, cloudfront: () => (cf ??= new CloudFrontClient({ region: CLOUDFRONT_REGION, credentials })) };
  cachedS3 = { key, s3 };
  return s3;
}

type Env = Parameters<typeof toEnvelope>[0];

type S3 = { client: S3Client; bucket: string; cloudfront: () => CloudFrontClient };

type RequestInput = z.infer<typeof requestUploadSchema>;

type Row = {
  id: number;
  project_id: number;
  kind: PublicEvidenceKind;
  sha256: string;
  size_bytes: number;
  content_type: string;
  original_name: string;
  object_key: string;
  status: PublicEvidenceStatus;
  reject_reason: string | null;
  run_id: number | null;
  commit_sha: string | null;
  uploaded_by: number | null;
  url_expires_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  removed_at: Date | null;
};

export type PublicEvidenceUpload = {
  object_id: string;
  status: "upload_required";
  method: "PUT";
  url: string;
  headers: { "content-type": string; "x-amz-checksum-sha256": string };
  expires_at: string;
  max_bytes: number;
  kind: PublicEvidenceKind;
  sha256: string;
  size_bytes: number;
  receipt: Receipt;
};

export type PublicEvidenceReceipt = {
  object_id: string;
  status: "public" | "exists";
  public_url: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  kind: PublicEvidenceKind;
  run_id: number | null;
  commit_sha: string | null;
  receipt: Receipt;
};

export type PublicEvidenceUploadResult = PublicEvidenceUpload | PublicEvidenceReceipt;

export type PublicEvidenceObject = {
  object_id: string;
  kind: PublicEvidenceKind;
  status: PublicEvidenceStatus;
  sha256: string;
  size_bytes: number;
  content_type: string;
  filename: string;
  public_url: string | null;
  run_id: number | null;
  commit_sha: string | null;
  reject_reason: string | null;
  upload_expires_at: string | null;
  created_at: string;
  completed_at: string | null;
  removed_at: string | null;
};

export type PublicEvidenceRemoval = {
  object_id: string;
  status: "removed";
  removed_at: string;
  cache_invalidation: "invalidated" | "not_configured" | "failed" | "not_needed";
  receipt: Receipt;
};
