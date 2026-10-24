import "server-only";
import { query } from "@/lib/db";

// Public evidence: files a team approved for the public S3 bucket
// (docs/api/PUBLIC_EVIDENCE.md). Only rows with status 'public' have a live
// object, served at EVIDENCE_CDN_BASE_URL/{object_key}.

export const PUBLIC_EVIDENCE_KINDS = ["screenshot", "video", "ndjson", "report", "testmd", "log"] as const;
export type PublicEvidenceKind = (typeof PUBLIC_EVIDENCE_KINDS)[number];
export type PublicEvidenceStatus = "pending" | "public" | "rejected" | "removed";

const ID_PREFIX = "PE-";

export type PublicEvidence = {
  id: string;
  kind: PublicEvidenceKind;
  sha256: string;
  size_bytes: number;
  content_type: string;
  url: string;
  run_id: number | null;
  commit_sha: string | null;
  completed_at: string;
};

/** Public objects of a project, newest first, optionally only the given numeric ids. */
export async function listPublicEvidence(projectId: number, ids?: number[]): Promise<PublicEvidence[]> {
  const rows = await query<{ id: number; kind: PublicEvidenceKind; sha256: string; size_bytes: string; content_type: string; object_key: string; run_id: number | null; commit_sha: string | null; completed_at: Date }>(
    `select id, kind, sha256, size_bytes, content_type, object_key, run_id, commit_sha, completed_at
       from public_evidence
      where project_id = $1 and status = 'public' and ($2::bigint[] is null or id = any($2::bigint[]))
      order by completed_at desc`,
    [projectId, ids ?? null],
  );
  return rows.map((r) => ({
    id: publicEvidenceId(r.id),
    kind: r.kind,
    sha256: r.sha256,
    size_bytes: Number(r.size_bytes),
    content_type: r.content_type,
    url: publicEvidenceUrl(r.object_key),
    run_id: r.run_id,
    commit_sha: r.commit_sha,
    completed_at: r.completed_at.toISOString(),
  }));
}

export const publicEvidenceId = (id: number) => `${ID_PREFIX}${id}`;

/** The numeric id in "PE-12" (or "12"), or null. */
export function parsePublicEvidenceId(ref: string): number | null {
  const m = /^(?:PE-)?(\d{1,18})$/i.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

export function publicEvidenceUrl(objectKey: string) {
  const base = process.env.EVIDENCE_CDN_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("EVIDENCE_CDN_BASE_URL is not set");
  return `${base}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}
