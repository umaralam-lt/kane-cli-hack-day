# Public evidence: AWS setup

`public-evidence-setup.sh` creates everything the app needs to serve participant-approved public evidence from the existing `kane-cli-hack-day` bucket. Every step reads the current state first and writes only what is missing or different, so it is safe to rerun. Block Public Access stays on.

## Prerequisites

- AWS CLI v2, `curl`, and `jq` or `python3`. Bash 3.2 (the macOS default) is enough.
- An operator profile that can create every resource in the table below. `--verify` also puts, reads and deletes objects under `incoming/` and `public/`.
- Run the script from the repo root. A new key file goes to `--key-out`. Name it `.env.public-evidence` so the repo's `.env*` rule keeps it out of git.

## Run

```sh
# 1. Dry run: every read runs, every write is printed with its JSON, nothing changes.
scripts/aws/public-evidence-setup.sh --profile <admin-profile> --dry-run

# 2. Real run: creates what is missing and waits for CloudFront to deploy (5 to 15 minutes).
scripts/aws/public-evidence-setup.sh --profile <admin-profile> --key-out .env.public-evidence

# 3. Verify: the setup part is now a no-op, then it checks CloudFront and S3 answers.
scripts/aws/public-evidence-setup.sh --profile <admin-profile> --key-out .env.public-evidence --verify
```

Other flags: `--bucket`, `--region`, `--user-name`, `--no-wait`, and `--force-cors`. `--force-cors` keeps a CORS configuration this script didn't write and puts our rule ahead of it. Without the flag the script stops. Run `--help` for details.

`--verify` puts `public/_healthcheck.txt` and `incoming/_healthcheck.txt` with SHA-256 checksums, then checks:

- the CloudFront URL of the public object answers 200 with `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`, HSTS and `Access-Control-Allow-Origin`
- the CloudFront URL of the incoming object answers 403
- the direct S3 URL answers 403
- `HeadObject --checksum-mode ENABLED` returns `ChecksumSHA256`
- a PutObject whose body doesn't match its signed SHA-256 is refused with `BadDigest` or `XAmzContentChecksumMismatch`

It then deletes the test objects. Checks that need the app user's own key are listed under [App-user checks](#app-user-checks).

## What it creates

| Resource | Name | Purpose |
| --- | --- | --- |
| IAM user | `kane-cli-hack-day-public-evidence` | Signs the presigned upload URLs and does the server-side checks, copy, delete and invalidation. No console login. |
| Inline policy | `public-evidence-s3` | Put, Get and Delete on `incoming/*` and `public/*`. `s3:ListBucket` limited to those prefixes, so a missing key answers 404. `cloudfront:CreateInvalidation` on this distribution only. |
| Access key | (one, created only when the user has none) | Written to `--key-out` with mode 600 and never printed. |
| S3 CORS rule | `public-evidence-upload` | Lets the site, `localhost:3100` and `kane-cli-hack-day-*.vercel.app` previews PUT straight to S3. |
| S3 lifecycle rules | `public-evidence-expire-incoming`, `public-evidence-abort-incomplete-uploads` | Delete `incoming/` objects after 1 day. Abort incomplete multipart uploads after 1 day. |
| Origin access control | `kane-cli-hack-day-public-evidence-oac` | CloudFront signs its S3 requests with SigV4. No legacy OAI. |
| Response headers policy | `kane-cli-hack-day-public-evidence-headers` | `nosniff`, `no-referrer`, HSTS, a sandboxing CSP, and CORS for GET and HEAD. |
| Distribution | Comment `kane-cli-hack-day public evidence` | Serves the bucket's regional endpoint with GET and HEAD only, HTTPS redirect, `CachingOptimized`, PriceClass_100, HTTP/2 and 3, IPv6 and the default certificate. |
| Bucket policy statements | `PublicEvidenceCloudFrontRead`, `PublicEvidenceDenyInsecureTransport` | CloudFront may read `public/*` only for this distribution's ARN. Plain-HTTP requests are denied. Existing statements are kept. |

The CloudFront response headers policy allows previews as `https://*.vercel.app`. CloudFront only accepts a wildcard as the whole leftmost label, so it can't take the narrower S3 pattern. That's harmless here because the objects are public and the CORS rule allows no credentials.

## Vercel environment variables

Set these in both **Production** and **Preview**. The script prints the values at the end:

```
EVIDENCE_S3_BUCKET=kane-cli-hack-day
EVIDENCE_S3_REGION=us-east-1
EVIDENCE_CDN_BASE_URL=https://<distribution>.cloudfront.net
EVIDENCE_CDN_DISTRIBUTION_ID=<distribution id>
EVIDENCE_S3_ACCESS_KEY_ID=<from the key file>
EVIDENCE_S3_SECRET_ACCESS_KEY=<from the key file>
```

For example, run `vercel env add EVIDENCE_S3_SECRET_ACCESS_KEY production`, then run it again with `preview`, and paste the value from `.env.public-evidence`. If `EVIDENCE_CDN_DISTRIBUTION_ID` is unset, the app skips cache invalidation and reports it as `not_configured`. Redeploy, then delete the key file.

## App-user checks

These need the app user's own key, so the script doesn't run them. Set the values the script printed. The subshell keeps the key out of your shell:

```sh
KEY_FILE=.env.public-evidence BUCKET=kane-cli-hack-day REGION=us-east-1 DIST_ID=<EVIDENCE_CDN_DISTRIBUTION_ID>
printf 'app user check\n' > right.txt
printf 'tampered\n' > wrong.txt
SUM=$(openssl dgst -sha256 -binary right.txt | base64)
(
  export AWS_ACCESS_KEY_ID="$(sed -n 's/^EVIDENCE_S3_ACCESS_KEY_ID=//p' "$KEY_FILE")"
  export AWS_SECRET_ACCESS_KEY="$(sed -n 's/^EVIDENCE_S3_SECRET_ACCESS_KEY=//p' "$KEY_FILE")"
  unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
  aws sts get-caller-identity --query Arn --output text

  # 1. A body that doesn't match the signed checksum: expect (BadDigest) or (XAmzContentChecksumMismatch).
  aws s3api put-object --region "$REGION" --bucket "$BUCKET" --key incoming/_check.txt \
    --body wrong.txt --content-type text/plain --checksum-sha256 "$SUM"

  # 2. Upload with --checksum-algorithm SHA256, then HEAD in checksum mode: expect the same value as $SUM.
  aws s3api put-object --region "$REGION" --bucket "$BUCKET" --key incoming/_check.txt \
    --body right.txt --content-type text/plain --checksum-algorithm SHA256
  aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key incoming/_check.txt \
    --checksum-mode ENABLED --query ChecksumSHA256 --output text
  echo "$SUM"

  # 3. A missing key under incoming/: expect "(404) ... Not Found", not (403).
  aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key incoming/_does-not-exist.txt

  # 4. Copy to public/ the way the app does: expect a CopyObjectResult with ChecksumSHA256.
  aws s3api copy-object --region "$REGION" --bucket "$BUCKET" --key public/_check.txt \
    --copy-source "$BUCKET/incoming/_check.txt" --checksum-algorithm SHA256

  # 5. Invalidation on this distribution: expect an invalidation Id.
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths /public/_check.txt \
    --query Invalidation.Id --output text

  aws s3api delete-object --region "$REGION" --bucket "$BUCKET" --key incoming/_check.txt
  aws s3api delete-object --region "$REGION" --bucket "$BUCKET" --key public/_check.txt
)
```

To repeat check 1 through a real presigned URL, ask the app for an upload URL for `right.txt`. Then PUT `wrong.txt` to it with the headers the app lists. Expect HTTP 400:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X PUT -H 'content-type: text/plain' \
  -H "x-amz-checksum-sha256: $SUM" --data-binary @wrong.txt "$UPLOAD_URL"
rm -f right.txt wrong.txt
```

If check 3 answers (403), S3 doesn't count the prefix-limited `s3:ListBucket` for the not-found check. The app then can't tell a missing upload from a denied one. To fix it, remove the `Condition` from the `EvidenceListForNotFound` statement in `build_user_policy` and rerun. The bucket only holds `incoming/` and `public/`, so this exposes no other keys.

If check 4 answers (AccessDenied), the likely cause is the annotation permissions that CopyObject's default `COPY` annotation directive can require. Send `x-amz-object-annotation-directive: EXCLUDE` with the app's CopyObject. Uploads never carry annotations, so nothing is lost.

## Rotate the access key

IAM allows two keys per user, so rotation needs no downtime:

```sh
U=kane-cli-hack-day-public-evidence
(umask 077; aws --profile <admin-profile> iam create-access-key --user-name "$U" --output text \
  --query "[join('', ['EVIDENCE_S3_ACCESS_KEY_ID=', AccessKey.AccessKeyId]), join('', ['EVIDENCE_S3_SECRET_ACCESS_KEY=', AccessKey.SecretAccessKey])]" \
  | tr '\t' '\n' > .env.public-evidence-new)
# Update both key variables in Vercel (Production and Preview) and redeploy. Then retire the old key:
aws --profile <admin-profile> iam update-access-key --user-name "$U" --access-key-id <old-key-id> --status Inactive
aws --profile <admin-profile> iam delete-access-key --user-name "$U" --access-key-id <old-key-id>
```

If the user has no key at all, rerun the script with a new `--key-out` file and it creates one.

## Teardown

Run these in order with `--profile <admin-profile>` on each command. Remove the Vercel variables first.

```sh
B=kane-cli-hack-day U=kane-cli-hack-day-public-evidence DIST_ID=<distribution id>

# 1. Disable, then delete the distribution (needs jq).
aws cloudfront get-distribution-config --id "$DIST_ID" > dist.json
jq '.DistributionConfig | .Enabled = false' dist.json > dist-off.json
aws cloudfront update-distribution --id "$DIST_ID" --if-match "$(jq -r .ETag dist.json)" --distribution-config file://dist-off.json
aws cloudfront wait distribution-deployed --id "$DIST_ID"
aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$(aws cloudfront get-distribution --id "$DIST_ID" --query ETag --output text)"

# 2. The response headers policy and the origin access control.
RHP=$(aws cloudfront list-response-headers-policies --type custom --output text \
  --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='kane-cli-hack-day-public-evidence-headers'].[ResponseHeadersPolicy.Id]")
aws cloudfront delete-response-headers-policy --id "$RHP" --if-match "$(aws cloudfront get-response-headers-policy --id "$RHP" --query ETag --output text)"
OAC=$(aws cloudfront list-origin-access-controls --output text \
  --query "OriginAccessControlList.Items[?Name=='kane-cli-hack-day-public-evidence-oac'].[Id]")
aws cloudfront delete-origin-access-control --id "$OAC" --if-match "$(aws cloudfront get-origin-access-control --id "$OAC" --query ETag --output text)"

# 3. Bucket config. If ours are the only rules and statements, delete them outright:
aws s3api delete-bucket-policy --bucket "$B"
aws s3api delete-bucket-cors --bucket "$B"
aws s3api delete-bucket-lifecycle --bucket "$B"
# Otherwise remove only the IDs and Sids in the table above and put the rest back.

# 4. Objects.
aws s3 rm "s3://$B/incoming/" --recursive
aws s3 rm "s3://$B/public/" --recursive

# 5. The IAM user.
for k in $(aws iam list-access-keys --user-name "$U" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name "$U" --access-key-id "$k"
done
aws iam delete-user-policy --user-name "$U" --policy-name public-evidence-s3
aws iam delete-user --user-name "$U"
rm -f dist.json dist-off.json
```
