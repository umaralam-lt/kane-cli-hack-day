# Public evidence: the upload contract

How a team publishes participant-approved evidence files (screenshots, videos, Kane NDJSON, reports, `_test.md` files, logs) to a public URL. This is the contract the hack-os participant skill and the `kanehack` client implement. It is complete on its own.

Public evidence is separate from **private** evidence (`/api/v1/kane/evidence`, private Blob). Whole Kane evidence packs stay private. A public object proves only that the team published those bytes. It does not prove a passing run or a backend milestone.

## The flow

```text
1. POST /api/v1/evidence/public/uploads            → PE-12, presigned PUT url + exact headers (10 min)
2. PUT <url> with exactly those headers + the bytes → straight to S3 (no app auth)
3. POST /api/v1/evidence/public/uploads/PE-12/complete → server re-hashes, checks, publishes → public_url
4. GET <public_url>                                → anyone can read it (CloudFront)
```

The same four steps exist as MCP tools on `/mcp` (see [MCP tools](#mcp-tools)). The skill calls the tools over MCP and does the PUT over HTTPS.

## Auth

| Who | How | May |
|---|---|---|
| Team member (CLI, skill, MCP) | `Authorization: Bearer khk_…` from `kanehack pair` | request, complete, list, read, remove (before the lock) |
| Team member (browser) | the member session cookie | the same |
| Judge, mentor, organizer | staff cookie | list (`?project_id=`) and read |
| Organizer | staff cookie | remove at any time, including after the lock |

- When the server runs with `TESTMU_KEY_REQUIRED=true`, every call to these routes and to `/mcp` also needs the TestMu AI key: send `X-TestMu-Username` and `X-TestMu-Access-Key` next to the bearer token. Details are in [TESTMU_ACCESS.md](TESTMU_ACCESS.md).
- The caller must be a member of a team that has a project. Passing another team's `project_id` is `FORBIDDEN`. Another team's `PE-n` is `NOT_FOUND`.
- Staff can't upload.
- The PUT in step 2 carries no app credentials. The presigned URL is the authorization: it is scoped to one key, one size, one content type and one sha256, for 10 minutes. Never put reusable storage credentials in the skill.

## What may be published

| kind | extensions | `content_type` you may declare | served as | max size |
|---|---|---|---|---|
| `screenshot` | `.png` `.jpg` `.webp` | `image/png`, `image/jpeg` (or `image/jpg`), `image/webp` | the image type | 50 MB |
| `video` | `.mp4` `.webm` | `video/mp4`, `video/webm` | the video type | 50 MB |
| `ndjson` | `.ndjson` `.jsonl` | `application/x-ndjson`, `application/ndjson`, `application/jsonl`, `application/json`, `text/plain` | `text/plain; charset=utf-8` | 10 MB |
| `report` | `.json` `.md` `.txt` | `.json`: `application/json`, `text/plain`. `.md`: `text/markdown`, `text/x-markdown`, `text/plain`. `.txt`: `text/plain` | `text/plain; charset=utf-8` | 10 MB |
| `testmd` | `.md` | `text/markdown`, `text/x-markdown`, `text/plain` | `text/plain; charset=utf-8` | 10 MB |
| `log` | `.log` `.txt` | `text/plain` | `text/plain; charset=utf-8` | 10 MB |

- MB here means MiB: 50 MB is 52,428,800 bytes and 10 MB is 10,485,760 bytes.
- **Never published:** `.evidence` packs, `.zip`, `.har`, `.html`/`.htm`/`.xhtml`, `.svg` and `.pdf`. A Kane pack holds a network HAR with cookies and auth headers. HTML, SVG and PDF can run script. These are refused at step 1, whatever the `kind`.
- Text is always served as plain text and never rendered as HTML. A `.md` report shows as Markdown source.
- Parameters on `content_type` (such as `; charset=utf-8`) are ignored when it is checked.

What the server checks on the bytes at step 3:

- The size and sha256 match what you declared.
- Images and videos start with the signature of their exact extension (a PNG named `.jpg` is rejected).
- Nothing starts like an executable or a script (`MZ`, ELF, Mach-O, `#!`).
- Text kinds are clean UTF-8 with no NUL bytes.
- Text kinds are scanned for credentials with the same scanner as Kane run reports. It looks for credential-shaped values on every line (GitHub, OpenAI-style, Slack and AWS keys, JWTs, private keys, `Bearer …`/`Basic …`, `LT_ACCESS_KEY=`). In `.ndjson`, `.jsonl` and `.json` it also looks at secret-named fields (`password`, `token`, `api_key`, `authorization`, `cookie`, …) that hold a value.
- A `.json` report that is a HAR (`{"log": {"entries": […]}}`) is rejected.

To publish a file that had a secret in it, replace the value with `[REDACTED]` (or `***`) and upload the new file. Redacted values pass the scan. The scan is a backstop. The participant approving the file is the real check, so redact before you ask.

## 1. Request an upload

`POST /api/v1/evidence/public/uploads`

```json
{
  "kind": "screenshot",
  "filename": "checkout-success.png",
  "content_type": "image/png",
  "size_bytes": 182734,
  "sha256": "9f2c…64 hex…",
  "run_id": 41,
  "commit_sha": "3e1f…40 hex…",
  "participant_approved": true,
  "idempotency_key": "pe-9f2c…-attempt-1"
}
```

| field | required | notes |
|---|---|---|
| `kind` | yes | one of the kinds above |
| `filename` | yes | ≤ 200 chars, no `/`, `\` or `..`. The extension decides the type. |
| `content_type` | yes | must be allowed for that extension (table above) |
| `size_bytes` | yes | exact byte length of the file |
| `sha256` | yes | lowercase or uppercase hex sha256 of the exact bytes you will PUT |
| `run_id` | no | our run id (`41` or `"KR-41"`). Must be in your project. |
| `kane_execution_id` | no | instead of `run_id`: the Kane execution id you reported (`kane_runs.upstream_execution_id`). Must be in your project. Send one or the other, not both. |
| `commit_sha` | no | full 40-hex commit SHA |
| `project_id` | no | your own project id. Anything else is `FORBIDDEN`. |
| `participant_approved` | yes | must be `true`: the participant approved publishing this exact file for anyone to read |
| `idempotency_key` | yes | 8–200 chars, in the body or as the `Idempotency-Key` header |

The body may also be wrapped as `{ "idempotency_key": "…", "payload": { … } }`.

### Response: upload required

`200`, envelope `status: "needs_action"`, `data`:

```json
{
  "object_id": "PE-12",
  "status": "upload_required",
  "method": "PUT",
  "url": "https://kane-cli-hack-day.s3.us-east-1.amazonaws.com/incoming/p7/9f2c….png?X-Amz-Algorithm=AWS4-HMAC-SHA256&…&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256&…",
  "headers": {
    "content-type": "image/png",
    "x-amz-checksum-sha256": "nyzG…base64…="
  },
  "expires_at": "2026-10-24T17:10:00.000Z",
  "max_bytes": 52428800,
  "kind": "screenshot",
  "sha256": "9f2c…",
  "size_bytes": 182734,
  "receipt": { "id": "PE-12", "server_time": "2026-10-24T17:00:00.000Z" }
}
```

- `headers["x-amz-checksum-sha256"]` is the base64 of the raw sha256 digest (not the hex). It is computed for you.
- Until step 3 succeeds, nothing is public and there is no public URL. Don't show or store one.

### Response: already published

If your team already published these exact bytes, no upload is needed. You get `200`, envelope `status: "ok"`, and `data` is the same shape as the step 3 receipt, with `status: "exists"`:

```json
{ "object_id": "PE-12", "status": "exists", "public_url": "https://dXXXX.cloudfront.net/public/p7/9f2c….png", "sha256": "9f2c…", "size_bytes": 182734, "content_type": "image/png", "kind": "screenshot", "run_id": 41, "commit_sha": "3e1f…", "receipt": { "id": "PE-12", "server_time": "2026-10-24T17:00:04.000Z" } }
```

## 2. PUT the bytes

PUT the exact file to `url`, sending **exactly** the two headers in `headers`. Your HTTP client sets `Content-Length` itself. It is signed too, so the body must be exactly `size_bytes` long.

```bash
curl --fail-with-body -X PUT "$URL" \
  -H "content-type: image/png" \
  -H "x-amz-checksum-sha256: nyzG…=" \
  --data-binary @checkout-success.png
```

```js
const r = await fetch(up.url, { method: up.method, headers: up.headers, body: await readFile(path) });
if (r.status !== 200) throw new Error(`PUT ${r.status}: ${await r.text()}`);
```

- Success is `200` with an empty body. Don't send `Authorization`, the TestMu key, extra `x-amz-*` headers or chunked transfer encoding.
- S3 itself refuses a body that doesn't match. A body with a different sha256 gets `400` (`BadDigest` on AWS, `XAmzContentChecksumMismatch` on MinIO). A different content type or length, or a missing signed header, gets a 4xx (`SignatureDoesNotMatch` or `AccessDenied`). An expired URL gets `403 AccessDenied` ("Request has expired"). Treat any non-200 as "not uploaded": request the upload again (step 1) and PUT again.
- The URL is S3's regional endpoint, not CloudFront. Browser PUTs are allowed by the bucket's CORS from `https://kaneclihack.sh`, `https://www.kaneclihack.sh`, `http://localhost:3100` and `https://kane-cli-hack-day-*.vercel.app`.

## 3. Complete

`POST /api/v1/evidence/public/uploads/{PE-n}/complete` (no body)

The server reads the uploaded object with its stored checksum, downloads it and re-hashes it, compares size and sha256, runs the checks above, then copies it to its public key and deletes the upload. `200`, envelope `status: "ok"`, `data`:

```json
{
  "object_id": "PE-12",
  "status": "public",
  "public_url": "https://dXXXX.cloudfront.net/public/p7/9f2c….png",
  "sha256": "9f2c…",
  "size_bytes": 182734,
  "content_type": "image/png",
  "kind": "screenshot",
  "run_id": 41,
  "commit_sha": "3e1f…",
  "receipt": { "id": "PE-12", "server_time": "2026-10-24T17:00:04.000Z" }
}
```

- Completing an object that is already public returns the same receipt (same `receipt.server_time`). Retrying is safe.
- If a check fails, those bytes are **rejected for good**: the upload is deleted, the object gets status `rejected` with the reason, and you get `VALIDATION_FAILED` with `error.details = { object_id, status: "rejected", reason, fields }`. `fields` says where a credential was found, for example `["line 2: password"]`. Fix the file. The fixed file has a new sha256 and becomes a new object.
- If the upload isn't there yet (never PUT, or the PUT failed), you get `NOT_FOUND` with `error.details.reason = "upload_missing"`. The object stays `pending`. PUT and complete again.
- If the stored bytes don't match the declared size and sha256, you get `VALIDATION_FAILED` with `error.details.reason = "digest_mismatch"`. The upload is deleted and the object stays `pending`, so request the upload again and PUT the exact file. With S3's signed checksum this shouldn't happen.

## Expiry, refresh and resume

- A presigned URL lasts **10 minutes** (`expires_at`).
- **Refresh:** call step 1 again with the same file and a **new** `idempotency_key`. You get the same `object_id` and a fresh URL. Repeating step 1 with the **same** key returns the original response unchanged, including its URL. That is meant for retrying a request whose response you lost.
- **Resume** is per object. There are no multipart or ranged uploads. If a PUT failed or the URL expired, request again and PUT the whole file again. Files already completed are untouched. Re-running the whole manifest is safe: completed files come back `exists` and pending ones get fresh URLs.
- An upload that is never completed costs nothing. Incoming uploads are deleted by the bucket after 1 day.

## Verifying the result

1. The server has already compared size and sha256, both from S3's stored checksum and by re-hashing the bytes.
2. To check the public copy yourself, GET `public_url` with no auth. Expect `200`, the `content_type` from the receipt, and a body whose sha256 and length match.
3. Persist the receipt (`object_id`, `public_url`, `sha256`, `size_bytes`, `receipt.server_time`) in your local manifest. Only a completed receipt means "uploaded".

## Stable ids and URLs

- `object_id` is `PE-<n>`. It is stable for a team and a sha256: the same bytes always map to the same `PE-n`, including after removal and re-publishing. Endpoints also accept the bare number.
- Object keys:
  - upload: `incoming/p{project_id}/{sha256}.{ext}` (never readable publicly)
  - public: `public/p{project_id}/{sha256}.{ext}`
- `public_url` = `EVIDENCE_CDN_BASE_URL + "/" + object_key`, for example `https://dXXXX.cloudfront.net/public/p7/9f2c….png`. The bytes behind a URL never change, so it is served with `Cache-Control: public, max-age=31536000, immutable` and `Content-Disposition: inline; filename="…"`.
- `nosniff`, the sandboxing CSP and GET CORS headers come from the CloudFront response-headers policy.

## Dedupe and status

One row per (team project, sha256):

| status | meaning | step 1 with the same bytes | step 3 |
|---|---|---|---|
| `pending` | upload URL issued, not yet published | same `PE-n`, fresh URL (the refresh path) | checks and publishes |
| `public` | published at `public_url` | `status: "exists"`, no upload | same receipt |
| `rejected` | these bytes failed a check | `VALIDATION_FAILED` with the stored reason | `VALIDATION_FAILED` with the stored reason |
| `removed` | was unpublished | reset to `pending`, same `PE-n`, fresh URL | `CONFLICT`: request again first |

A refresh may change `kind`, `filename` and `content_type` (nothing is public yet). `run_id` and `commit_sha` keep their earlier values unless you send new ones.

## Reading

- `GET /api/v1/evidence/public`: your team's objects, every status, newest first. Staff add `?project_id=`.
- `GET /api/v1/evidence/public/{PE-n}`: one object.

Each object:

```json
{ "object_id": "PE-12", "kind": "screenshot", "status": "public", "sha256": "9f2c…", "size_bytes": 182734, "content_type": "image/png", "filename": "checkout-success.png", "public_url": "https://dXXXX.cloudfront.net/public/p7/9f2c….png", "run_id": 41, "commit_sha": "3e1f…", "reject_reason": null, "upload_expires_at": null, "created_at": "…", "completed_at": "…", "removed_at": null }
```

`public_url` is set only while the status is `public`. `upload_expires_at` is set only while it is `pending`.

## Removing

`DELETE /api/v1/evidence/public/{PE-n}`, optional body `{ "reason": "published by mistake" }`. This is the safety valve for a file published by mistake.

- A team member can remove before the submission lock. An organizer can remove at any time. Judges and mentors can't.
- It sets status `removed` (with `removed_at`) and deletes the public object. Removing again is safe and retries the delete.
- A `rejected` object was never public, so removing it is `CONFLICT`.
- `data.cache_invalidation` says whether CloudFront was told to drop its cached copy: `invalidated`, `not_configured`, `failed` or `not_needed` (never public). Public objects are cached for a year. Unless it says `invalidated`, CloudFront may keep serving copies it already has until an organizer runs `aws cloudfront create-invalidation --distribution-id <id> --paths "/public/p7/<sha256>.png"`. Browsers that already downloaded the file keep their copy.

## Limits

| limit | value | error |
|---|---|---|
| file size | 50 MB (screenshot, video), 10 MB (text kinds) | `VALIDATION_FAILED` at step 1 |
| per team | 200 public objects and 1 GB (1,073,741,824 bytes). At step 1 this counts public objects plus uploads whose URL hasn't expired. At step 3 it counts public objects. | `VALIDATION_FAILED`, `error.details.reason = "team_quota"` (with `max_objects`, `max_bytes`, `used_objects`, `used_bytes`) |
| per member | 60 calls a minute across step 1 and step 3 | `RATE_LIMITED`, `error.details.retry_after_sec` |
| upload URL | 10 minutes | S3 `403 AccessDenied` (request again) |
| submission lock | after `submission_locks_at` (server clock), steps 1 and 3 and team removal are refused | `SUBMISSION_LOCKED` (`error.details.locks_at`, `server_time`) |

## Errors

Every response uses the standard envelope (`status`, `message`, `data`, `error`, `fallback.text`, `request_id`, `server_time`). On errors `error` is `{ code, message, next_action, manual_route, details }`.

| `error.code` | HTTP | when | what the client does |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | bad field (`details.issues`), refused type or size (`details.reason = "file_refused"`), bytes rejected (`details.status = "rejected"`), `digest_mismatch`, `team_quota` | don't retry as is. Fix the file or field, or remove objects for quota. |
| `UNAUTHENTICATED` | 401 | no or bad bearer token or session | pair again (`kanehack pair`) |
| `TESTMU_KEY_REQUIRED` | 401 | the TestMu gate is on and no key was sent | send `X-TestMu-Username` and `X-TestMu-Access-Key` |
| `FORBIDDEN` | 403 | staff uploading, no team or project, another team's `project_id`, a judge or mentor removing | stop. It's a permission problem. |
| `NOT_FOUND` | 404 | unknown or other team's `PE-n`, run not in your project, or `details.reason = "upload_missing"` | for `upload_missing`: PUT, then complete again |
| `CONFLICT` | 409 | completing a removed object, removing a rejected one, a concurrent change, or the same idempotency key still in flight | for removed: request again. Otherwise retry once. |
| `RATE_LIMITED` | 429 | over 60 calls a minute | wait `details.retry_after_sec` |
| `SUBMISSION_LOCKED` | 423 | after the submission lock | stop. Keep the files locally. An organizer can still remove. |
| `FEATURE_DISABLED` | 503 | the `public_evidence` kill switch is off | keep files and manifest with `upload=pending` |
| `DOWNSTREAM_DEGRADED` | 503 | not configured on this server (`details.reason = "not_configured"`), or S3 failing (`details.op`) | keep files and manifest with `upload=pending` and retry later. Never invent a URL or receipt. |

## MCP tools

On `/mcp` with the same bearer token. Each returns the same envelope as the REST route, as JSON text.

| tool | arguments | REST equivalent |
|---|---|---|
| `public_evidence_request_upload` | the step 1 body (`participant_approved` and `idempotency_key` included) | `POST /api/v1/evidence/public/uploads` |
| `public_evidence_complete` | `{ object_id }` | `POST /api/v1/evidence/public/uploads/{PE-n}/complete` |
| `public_evidence_list` | `{}` | `GET /api/v1/evidence/public` |
| `public_evidence_remove` | `{ object_id, reason?, explicit_confirmation }` | `DELETE /api/v1/evidence/public/{PE-n}` |

`public_evidence_remove` changes nothing without `explicit_confirmation: true`. It answers `needs_action` with a confirm action, like the other destructive tools. Send `true` only after the participant said yes.

## Client checklist

- Before step 1: the participant approved each exact file, private data is redacted, and the original local evidence is kept.
- Map every object to team, project, run (`run_id` or `kane_execution_id`) and commit.
- Keep a local manifest with `upload=pending` until you hold a step 3 receipt. On any 503, keep it pending and retry later.
- Never reuse the private evidence endpoint and call it public. Never fabricate an upload, receipt or public URL.

## Server configuration

Environment (namespaced, because Vercel reserves `AWS_*`):

| variable | required | example |
|---|---|---|
| `EVIDENCE_S3_BUCKET` | yes | `kane-cli-hack-day` |
| `EVIDENCE_S3_REGION` | yes | `us-east-1` |
| `EVIDENCE_CDN_BASE_URL` | yes | `https://dXXXX.cloudfront.net` (no path, no trailing slash) |
| `EVIDENCE_S3_ACCESS_KEY_ID` | yes | the app IAM user's key |
| `EVIDENCE_S3_SECRET_ACCESS_KEY` | yes | |
| `EVIDENCE_S3_ENDPOINT` | no | an S3-compatible test server, for example MinIO at `http://127.0.0.1:9102` (path-style) |
| `EVIDENCE_CDN_DISTRIBUTION_ID` | no | the CloudFront distribution id. When set, removal invalidates the object's path. |

If any required variable is missing, uploads answer `DOWNSTREAM_DEGRADED` ("public evidence isn't configured"). The `public_evidence` flag (ops settings) switches uploads off without a deploy. Reading and removal keep working.

### Bucket model

- The bucket is private: SSE-S3 (AES256), Block Public Access fully on, no public bucket policy.
- Public reads go through CloudFront with Origin Access Control. The bucket policy lets only `cloudfront.amazonaws.com` (`SourceArn` = the distribution) `s3:GetObject` on `public/*`. Through CloudFront, `incoming/*` answers 403.
- S3 CORS allows PUT, GET and HEAD from the origins listed in step 2, with request headers `content-type`, `x-amz-checksum-sha256` and `x-amz-sdk-checksum-algorithm`, and exposes `ETag`.
- A lifecycle rule expires `incoming/` after 1 day.
- `scripts/aws/public-evidence-setup.sh` creates and applies all of this: the IAM user and keys, CORS, lifecycle, OAC, the distribution, the response-headers policy and the bucket policy.

### App IAM

The app keys need only:

- `s3:PutObject` on `incoming/*` and `public/*` (presigned uploads and the publishing copy)
- `s3:GetObject` and `s3:DeleteObject` on `incoming/*` and `public/*`
- `s3:ListBucket` on the bucket, limited to the prefixes `incoming/` and `public/`, so a missing key is 404 rather than 403. The server treats a 403 on a missing upload as "not uploaded yet" too.
- Optional: `cloudfront:CreateInvalidation` on the distribution, together with `EVIDENCE_CDN_DISTRIBUTION_ID`, so removal also clears CloudFront's cache.

## Coverage of the pending contract

How this answers `public_evidence_upload.required_details` in `docs/hack-os/release/pending-contracts.json`:

| required detail | answered in |
|---|---|
| Authorization/scoped upload issuance | [Auth](#auth), [1. Request an upload](#1-request-an-upload) |
| Method/headers/content types/size limits | [What may be published](#what-may-be-published), [2. PUT the bytes](#2-put-the-bytes), [Limits](#limits) |
| Expiry/refresh and per-object resume | [Expiry, refresh and resume](#expiry-refresh-and-resume) |
| Completion and digest verification | [3. Complete](#3-complete), [Verifying the result](#verifying-the-result) |
| Stable object ID/public URL/readback | [Stable ids and URLs](#stable-ids-and-urls), [Reading](#reading) |
| Deduplication and error semantics | [Dedupe and status](#dedupe-and-status), [Errors](#errors) |
