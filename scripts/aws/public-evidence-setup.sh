#!/usr/bin/env bash
# Idempotently creates the AWS resources that serve public evidence from S3 through CloudFront (see README.md here).
set -euo pipefail

DEFAULT_BUCKET="kane-cli-hack-day"
DEFAULT_REGION="us-east-1"
INCOMING_PREFIX="incoming/"
PUBLIC_PREFIX="public/"
UPLOAD_ORIGINS=("https://kaneclihack.sh" "https://www.kaneclihack.sh" "http://localhost:3100" "https://kane-cli-hack-day-*.vercel.app")
# CloudFront takes a wildcard only as a whole leftmost label, so preview deployments match *.vercel.app here.
CDN_ORIGINS=("https://kaneclihack.sh" "https://www.kaneclihack.sh" "http://localhost:3100" "https://*.vercel.app")
UPLOAD_HEADERS=("content-type" "x-amz-checksum-sha256" "x-amz-sdk-checksum-algorithm" "x-amz-content-sha256" "x-amz-date" "authorization")
CSP="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
HSTS_MAX_AGE=63072000
CORS_MAX_AGE=3000
CORS_RULE_ID="public-evidence-upload"
LIFECYCLE_EXPIRE_ID="public-evidence-expire-incoming"
LIFECYCLE_ABORT_ID="public-evidence-abort-incomplete-uploads"
INLINE_POLICY_NAME="public-evidence-s3"
POLICY_SID_CDN_READ="PublicEvidenceCloudFrontRead"
POLICY_SID_TLS_ONLY="PublicEvidenceDenyInsecureTransport"
CACHE_POLICY_NAME="Managed-CachingOptimized"
HEALTHCHECK_FILE="_healthcheck.txt"
MISMATCH_FILE="_checksum-mismatch.txt"
# Base64 SHA-256 of the empty string, which never matches a non-empty body.
EMPTY_SHA256_B64="47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="

PROFILE=""
BUCKET=$DEFAULT_BUCKET
REGION=$DEFAULT_REGION
USER_NAME=""
KEY_OUT=""
DRY_RUN=0
VERIFY=0
WAIT=1
FORCE_CORS=0

USER_EXISTS=0
KEY_LINES=""
ACCESS_KEY_ID=""
KEY_CREATED=0
OAC_ID=""
HEADERS_POLICY_ID=""
CACHE_POLICY_ID=""
DIST_ID=""
DIST_ARN=""
DIST_DOMAIN=""
DIST_STATUS=""
WRITES=0
FAILURES=0
OUT=""
WRITE_OUT=""
CLEANUP_KEYS=()

main() {
  parse_args "$@"
  derive_names
  AWS=(aws --region "$REGION")
  if [[ -n $PROFILE ]]; then
    AWS+=(--profile "$PROFILE")
  fi
  export AWS_PAGER=""
  TMP=$(mktemp -d)
  trap on_exit EXIT

  preflight
  ensure_iam_user
  ensure_access_key
  ensure_cors
  ensure_lifecycle
  ensure_oac
  ensure_headers_policy
  ensure_distribution
  ensure_user_policy
  ensure_bucket_policy
  wait_for_distribution
  print_env
  if (( VERIFY )); then
    verify
  fi
  if (( DRY_RUN )); then
    step "Dry run finished: $WRITES write call(s) planned, none made"
  fi
}

parse_args() {
  while (( $# )); do
    case $1 in
      --profile|--bucket|--region|--user-name|--key-out)
        (( $# >= 2 )) || die "$1 needs a value"
        set_option "$1" "$2"
        shift 2 ;;
      --profile=*|--bucket=*|--region=*|--user-name=*|--key-out=*)
        set_option "${1%%=*}" "${1#*=}"
        shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --verify) VERIFY=1; shift ;;
      --no-wait) WAIT=0; shift ;;
      --force-cors) FORCE_CORS=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
}

derive_names() {
  local bucket_re='^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' region_re='^[a-z]{2}(-[a-z]+)+-[0-9]+$' user_re='^[A-Za-z0-9+=,.@_-]{1,64}$'
  [[ $BUCKET =~ $bucket_re ]] || die "invalid bucket name: $BUCKET"
  [[ $REGION =~ $region_re ]] || die "invalid region: $REGION"
  USER_NAME=${USER_NAME:-$BUCKET-public-evidence}
  [[ $USER_NAME =~ $user_re ]] || die "invalid IAM user name: $USER_NAME"
  OAC_NAME=$BUCKET-public-evidence-oac
  HEADERS_POLICY_NAME=$BUCKET-public-evidence-headers
  DIST_COMMENT="$BUCKET public evidence"
  ORIGIN_ID=s3-$BUCKET
  ORIGIN_DOMAIN=$BUCKET.s3.$REGION.amazonaws.com
  (( ${#OAC_NAME} <= 64 )) || die "bucket name too long for the OAC name $OAC_NAME (64 characters max)"
}

preflight() {
  local version
  step "Preflight"
  command -v aws >/dev/null 2>&1 || die "AWS CLI v2 not found"
  version=$(aws --version 2>&1)
  [[ $version == aws-cli/2.* ]] || die "need AWS CLI v2, found: $version"
  json_engine_init
  if (( VERIFY )); then
    command -v curl >/dev/null 2>&1 || die "--verify needs curl"
  fi
  info "AWS CLI ${version%% *}, JSON via $JSON"
  if (( DRY_RUN )); then
    info "DRY RUN: every read runs, every write is printed and skipped"
  fi

  aws_get "" sts get-caller-identity --query '[Account, Arn]'
  read -r ACCOUNT_ID CALLER_ARN <<<"$OUT"
  PARTITION=$(cut -d: -f2 <<<"$CALLER_ARN")
  BUCKET_ARN="arn:$PARTITION:s3:::$BUCKET"
  info "running as $CALLER_ARN"

  check_bucket
  check_user_and_key
  check_cors_conflict
  check_policy_conflict
  check_cache_policy
}

check_bucket() {
  local loc
  step "Bucket $BUCKET"
  aws_get "" s3api get-bucket-location --bucket "$BUCKET" --query LocationConstraint
  loc=$OUT
  if [[ $loc == None || -z $loc ]]; then
    loc=us-east-1
  fi
  [[ $loc == "$REGION" ]] || die "bucket $BUCKET is in $loc, not $REGION (pass --region $loc)"
  info "region: $loc"

  if aws_get NoSuchPublicAccessBlockConfiguration s3api get-public-access-block --bucket "$BUCKET" \
      --query 'PublicAccessBlockConfiguration.[BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets]'; then
    if [[ $OUT == $'True\tTrue\tTrue\tTrue' ]]; then
      info "Block Public Access: all four settings on (left on)"
    else
      warn "Block Public Access is not fully on ($OUT). This script never changes it and does not need it off."
    fi
  else
    warn "the bucket has no Block Public Access configuration. This script never changes it."
  fi

  if aws_get ServerSideEncryptionConfigurationNotFoundError s3api get-bucket-encryption --bucket "$BUCKET" \
      --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm'; then
    info "default encryption: $OUT"
    if [[ $OUT == aws:kms* ]]; then
      warn "SSE-KMS needs KMS grants for the app user and CloudFront that this script does not create"
    fi
  fi

  if aws_get OwnershipControlsNotFoundError s3api get-bucket-ownership-controls --bucket "$BUCKET" \
      --query 'OwnershipControls.Rules[0].ObjectOwnership'; then
    info "object ownership: $OUT"
  fi

  aws_get "" s3api get-bucket-versioning --bucket "$BUCKET" --query Status
  if [[ $OUT == Enabled ]]; then
    warn "versioning is on, so the incoming/ expiry leaves noncurrent versions behind"
  else
    info "versioning: ${OUT/None/never enabled}"
  fi
}

check_user_and_key() {
  step "Check IAM user $USER_NAME and its access keys"
  if aws_get NoSuchEntity iam get-user --user-name "$USER_NAME" --query User.Arn; then
    USER_EXISTS=1
    info "exists: $OUT"
    aws_list iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].[AccessKeyId,Status]'
    KEY_LINES=$OUT
    report_other_user_access
  else
    info "not found, will be created"
  fi

  if [[ -n $KEY_LINES ]]; then
    info "access keys: $(one_line "$KEY_LINES")"
    if [[ -n $KEY_OUT && ! -e $KEY_OUT ]]; then
      info "a key already exists, so nothing will be written to $KEY_OUT"
    fi
    return
  fi
  if [[ -z $KEY_OUT ]]; then
    fail_or_warn "a new access key will be created: pass --key-out FILE"
  elif [[ -e $KEY_OUT ]]; then
    fail_or_warn "$KEY_OUT already exists: refusing to overwrite it with a new key"
  elif [[ ! -d $(dirname "$KEY_OUT") || ! -w $(dirname "$KEY_OUT") ]]; then
    fail_or_warn "cannot write $KEY_OUT: its directory is missing or read-only"
  else
    info "a new access key will be written to $KEY_OUT (mode 600)"
  fi
}

report_other_user_access() {
  aws_list iam list-user-policies --user-name "$USER_NAME" --query "PolicyNames[?@ != '$INLINE_POLICY_NAME'].[@]"
  if [[ -n $OUT ]]; then
    warn "the user has other inline policies: $(one_line "$OUT")"
  fi
  aws_list iam list-attached-user-policies --user-name "$USER_NAME" --query 'AttachedPolicies[].[PolicyName]'
  if [[ -n $OUT ]]; then
    warn "the user has attached managed policies: $(one_line "$OUT")"
  fi
  aws_list iam list-groups-for-user --user-name "$USER_NAME" --query 'Groups[].[GroupName]'
  if [[ -n $OUT ]]; then
    warn "the user is in groups: $(one_line "$OUT")"
  fi
}

check_cors_conflict() {
  local rc=0
  build_cors "$TMP/cors.json"
  if aws_get_json "$TMP/cors-current.json" NoSuchCORSConfiguration s3api get-bucket-cors --bucket "$BUCKET"; then
    json_merge_cors "$TMP/cors-current.json" "$TMP/cors.json" "$FORCE_CORS" >"$TMP/cors-merged.json" || rc=$?
    case $rc in
      0|4) ;;
      3) die "the bucket has a CORS configuration this script did not write. Rerun with --force-cors to keep its rules and add ours ahead of them." ;;
      *) die "could not merge the existing CORS configuration" ;;
    esac
  fi
}

check_policy_conflict() {
  local rc=0
  if aws_get NoSuchBucketPolicy s3api get-bucket-policy --bucket "$BUCKET" --query Policy; then
    printf '%s\n' "$OUT" >"$TMP/bucket-policy-current.json"
    json_check "$TMP/bucket-policy-current.json" || die "the existing bucket policy is not valid JSON"
    build_bucket_policy "$TMP/bucket-policy-probe.json" "arn:$PARTITION:cloudfront::$ACCOUNT_ID:distribution/PROBE"
    json_merge_policy "$TMP/bucket-policy-current.json" "$TMP/bucket-policy-probe.json" >/dev/null || rc=$?
    case $rc in
      0|4) ;;
      3) die "the existing bucket policy cannot be merged safely (reason above). Fix it by hand, then rerun." ;;
      *) die "could not merge the existing bucket policy" ;;
    esac
  fi
}

check_cache_policy() {
  step "CloudFront cache policy $CACHE_POLICY_NAME"
  aws_list cloudfront list-cache-policies --type managed \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$CACHE_POLICY_NAME'].[CachePolicy.Id]"
  [[ $(line_count "$OUT") == 1 ]] || die "managed cache policy $CACHE_POLICY_NAME not found"
  CACHE_POLICY_ID=$OUT
  info "id: $CACHE_POLICY_ID"
}

ensure_iam_user() {
  step "IAM user $USER_NAME"
  if (( USER_EXISTS )); then
    info "exists"
    return
  fi
  run_write "create the IAM user" iam create-user --user-name "$USER_NAME" --query User.Arn --output text
}

ensure_access_key() {
  step "Access key"
  if [[ -n $KEY_LINES ]]; then
    ACCESS_KEY_ID=$(awk -F'\t' '$2 == "Active" { print $1; exit }' <<<"$KEY_LINES")
    if [[ -z $ACCESS_KEY_ID ]]; then
      warn "the user has no active access key. Activate or rotate one (README)."
    fi
    info "exists, not creating another"
    return
  fi
  WRITES=$((WRITES + 1))
  info "create an access key and write it to ${KEY_OUT:-<--key-out FILE>} (mode 600, never printed)"
  printf '      $' >&2
  printf ' %q' "${AWS[@]}" iam create-access-key --user-name "$USER_NAME" >&2
  printf ' > %q\n' "${KEY_OUT:-FILE}" >&2
  if (( DRY_RUN )); then
    info "(dry run: skipped)"
    ACCESS_KEY_ID="<new access key id>"
    return
  fi
  write_access_key
  ACCESS_KEY_ID=$(sed -n 's/^EVIDENCE_S3_ACCESS_KEY_ID=//p' "$KEY_OUT")
  KEY_CREATED=1
  info "created $ACCESS_KEY_ID, secret saved in $KEY_OUT"
}

ensure_cors() {
  local rc=0
  step "S3 CORS"
  if [[ ! -f $TMP/cors-current.json ]]; then
    info "none yet"
    cp "$TMP/cors.json" "$TMP/cors-merged.json"
  else
    json_merge_cors "$TMP/cors-current.json" "$TMP/cors.json" "$FORCE_CORS" >"$TMP/cors-merged.json" || rc=$?
    if (( rc == 4 )); then
      info "up to date"
      return
    fi
    info "merging rule $CORS_RULE_ID into the existing configuration"
  fi
  run_write "put the bucket CORS configuration" s3api put-bucket-cors --bucket "$BUCKET" \
    --cors-configuration "file://$TMP/cors-merged.json"
}

ensure_lifecycle() {
  local rc=0 min_size=""
  step "S3 lifecycle"
  build_lifecycle "$TMP/lifecycle.json"
  if aws_get_json "$TMP/lifecycle-current.json" NoSuchLifecycleConfiguration \
      s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"; then
    json_merge_lifecycle "$TMP/lifecycle-current.json" "$TMP/lifecycle.json" >"$TMP/lifecycle-merged.json" || rc=$?
    case $rc in
      0) info "merging rules $LIFECYCLE_EXPIRE_ID and $LIFECYCLE_ABORT_ID into the existing rules" ;;
      4) info "up to date"; return ;;
      *) die "could not merge the existing lifecycle configuration" ;;
    esac
    aws_get "" s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --query TransitionDefaultMinimumObjectSize
    if [[ $OUT != None ]]; then
      min_size=$OUT
    fi
  else
    info "none yet"
    cp "$TMP/lifecycle.json" "$TMP/lifecycle-merged.json"
  fi
  if [[ -n $min_size ]]; then
    run_write "put the lifecycle configuration" s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
      --lifecycle-configuration "file://$TMP/lifecycle-merged.json" --transition-default-minimum-object-size "$min_size"
  else
    run_write "put the lifecycle configuration" s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
      --lifecycle-configuration "file://$TMP/lifecycle-merged.json"
  fi
}

ensure_oac() {
  local protocol behavior origin_type
  step "CloudFront origin access control $OAC_NAME"
  aws_list cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].[Id,SigningProtocol,SigningBehavior,OriginAccessControlOriginType]"
  if [[ -n $OUT ]]; then
    read -r OAC_ID protocol behavior origin_type <<<"$OUT"
    info "exists: $OAC_ID"
    if [[ $protocol/$behavior/$origin_type != sigv4/always/s3 ]]; then
      warn "it signs as $protocol/$behavior/$origin_type, not sigv4/always/s3. Left unchanged."
    fi
    return
  fi
  build_oac "$TMP/oac.json"
  run_write "create the origin access control" cloudfront create-origin-access-control \
    --origin-access-control-config "file://$TMP/oac.json" --query OriginAccessControl.Id --output text
  OAC_ID=${WRITE_OUT:-<new-oac-id>}
}

ensure_headers_policy() {
  local etag
  step "CloudFront response headers policy $HEADERS_POLICY_NAME"
  build_headers_policy "$TMP/headers-policy.json"
  aws_list cloudfront list-response-headers-policies --type custom \
    --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$HEADERS_POLICY_NAME'].[ResponseHeadersPolicy.Id]"
  if [[ -z $OUT ]]; then
    run_write "create the response headers policy" cloudfront create-response-headers-policy \
      --response-headers-policy-config "file://$TMP/headers-policy.json" --query ResponseHeadersPolicy.Id --output text
    HEADERS_POLICY_ID=${WRITE_OUT:-<new-headers-policy-id>}
    return
  fi
  HEADERS_POLICY_ID=$OUT
  info "exists: $HEADERS_POLICY_ID"
  aws_get_json "$TMP/headers-policy-current.json" "" cloudfront get-response-headers-policy-config \
    --id "$HEADERS_POLICY_ID" --query ResponseHeadersPolicyConfig
  if json_same "$TMP/headers-policy-current.json" "$TMP/headers-policy.json"; then
    info "up to date"
    return
  fi
  info "differs from the desired config"
  aws_get "" cloudfront get-response-headers-policy-config --id "$HEADERS_POLICY_ID" --query ETag
  etag=$OUT
  run_write "update the response headers policy" cloudfront update-response-headers-policy \
    --id "$HEADERS_POLICY_ID" --if-match "$etag" --response-headers-policy-config "file://$TMP/headers-policy.json"
}

ensure_distribution() {
  local count
  step "CloudFront distribution \"$DIST_COMMENT\""
  aws_list cloudfront list-distributions --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].[Id,ARN,DomainName,Status]"
  count=$(line_count "$OUT")
  if (( count > 1 )); then
    die "$count distributions have the Comment \"$DIST_COMMENT\". Delete or rename the extras, then rerun."
  fi
  if (( count == 1 )); then
    read -r DIST_ID DIST_ARN DIST_DOMAIN DIST_STATUS <<<"$OUT"
    info "exists: $DIST_ID ($DIST_DOMAIN, $DIST_STATUS)"
    check_distribution_drift
    return
  fi
  build_distribution "$TMP/distribution.json"
  run_write "create the distribution" cloudfront create-distribution \
    --distribution-config "file://$TMP/distribution.json" --query 'Distribution.[Id,ARN,DomainName,Status]' --output text
  if (( DRY_RUN )); then
    DIST_ID="<new-distribution-id>"
    DIST_ARN="arn:$PARTITION:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID"
    DIST_DOMAIN="<new-distribution>.cloudfront.net"
    DIST_STATUS=InProgress
    return
  fi
  read -r DIST_ID DIST_ARN DIST_DOMAIN DIST_STATUS <<<"$WRITE_OUT"
  info "created $DIST_ID ($DIST_DOMAIN)"
}

check_distribution_drift() {
  local origin oac oai target cache headers viewer enabled
  aws_get "" cloudfront get-distribution-config --id "$DIST_ID" --query "DistributionConfig.[Origins.Items[0].DomainName, to_string(Origins.Items[0].OriginAccessControlId), to_string(Origins.Items[0].S3OriginConfig.OriginAccessIdentity), DefaultCacheBehavior.TargetOriginId, to_string(DefaultCacheBehavior.CachePolicyId), to_string(DefaultCacheBehavior.ResponseHeadersPolicyId), DefaultCacheBehavior.ViewerProtocolPolicy, to_string(Enabled)] | join('|', @)"
  IFS='|' read -r origin oac oai target cache headers viewer enabled <<<"$OUT"
  expect_setting "origin domain" "$origin" "$ORIGIN_DOMAIN"
  expect_setting "origin access control" "$oac" "$OAC_ID"
  expect_setting "legacy origin access identity" "$oai" ""
  expect_setting "default behaviour origin" "$target" "$ORIGIN_ID"
  expect_setting "cache policy" "$cache" "$CACHE_POLICY_ID"
  expect_setting "response headers policy" "$headers" "$HEADERS_POLICY_ID"
  expect_setting "viewer protocol policy" "$viewer" redirect-to-https
  expect_setting "enabled" "$enabled" true
}

# Runs after the distribution exists because the policy grants invalidations on its ARN.
ensure_user_policy() {
  step "IAM inline policy $INLINE_POLICY_NAME"
  build_user_policy "$TMP/user-policy.json"
  if (( USER_EXISTS )) && aws_get_json "$TMP/user-policy-current.json" NoSuchEntity \
      iam get-user-policy --user-name "$USER_NAME" --policy-name "$INLINE_POLICY_NAME" --query PolicyDocument; then
    if json_same "$TMP/user-policy-current.json" "$TMP/user-policy.json"; then
      info "up to date"
      return
    fi
    info "differs from the desired policy, replacing it"
  fi
  run_write "put the inline policy" iam put-user-policy --user-name "$USER_NAME" \
    --policy-name "$INLINE_POLICY_NAME" --policy-document "file://$TMP/user-policy.json"
}

ensure_bucket_policy() {
  local rc=0
  step "S3 bucket policy"
  build_bucket_policy "$TMP/bucket-policy-ours.json" "$DIST_ARN"
  if [[ -f $TMP/bucket-policy-current.json ]]; then
    json_merge_policy "$TMP/bucket-policy-current.json" "$TMP/bucket-policy-ours.json" >"$TMP/bucket-policy.json" || rc=$?
    case $rc in
      0) info "merging statements $POLICY_SID_CDN_READ and $POLICY_SID_TLS_ONLY into the existing policy" ;;
      4) info "up to date"; return ;;
      *) die "could not merge the existing bucket policy" ;;
    esac
  else
    info "none yet"
    cp "$TMP/bucket-policy-ours.json" "$TMP/bucket-policy.json"
  fi
  run_write "put the bucket policy" s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$TMP/bucket-policy.json"
}

wait_for_distribution() {
  if [[ $DIST_STATUS == Deployed ]] || (( DRY_RUN )); then
    return
  fi
  if (( ! WAIT )); then
    info "distribution $DIST_ID is $DIST_STATUS. Not waiting (--no-wait)."
    return
  fi
  step "Waiting for distribution $DIST_ID to deploy (usually 5 to 15 minutes)"
  "${AWS[@]}" cloudfront wait distribution-deployed --id "$DIST_ID" || die "distribution $DIST_ID did not finish deploying. Rerun to keep waiting."
  DIST_STATUS=Deployed
  info "deployed"
}

print_env() {
  local secret
  step "Vercel environment variables (Production and Preview)"
  if (( KEY_CREATED )) || { (( DRY_RUN )) && [[ -z $KEY_LINES ]]; }; then
    secret="in ${KEY_OUT:-<--key-out FILE>}"
  else
    secret="not retrievable: set when $ACCESS_KEY_ID was created (rotate it to get a new one, see README)"
  fi
  printf '%s\n' \
    "EVIDENCE_S3_BUCKET=$BUCKET" \
    "EVIDENCE_S3_REGION=$REGION" \
    "EVIDENCE_CDN_BASE_URL=https://$DIST_DOMAIN" \
    "EVIDENCE_CDN_DISTRIBUTION_ID=$DIST_ID" \
    "EVIDENCE_S3_ACCESS_KEY_ID=${ACCESS_KEY_ID:-<none active>}" \
    "EVIDENCE_S3_SECRET_ACCESS_KEY=($secret)"
}

verify() {
  local cdn="https://$DIST_DOMAIN" s3="https://$BUCKET.s3.$REGION.amazonaws.com"
  step "Verify"
  if (( DRY_RUN )); then
    info "would put $PUBLIC_PREFIX$HEALTHCHECK_FILE and $INCOMING_PREFIX$HEALTHCHECK_FILE with SHA-256 checksums, then check:"
    info "  $cdn/$PUBLIC_PREFIX$HEALTHCHECK_FILE answers 200 with the security and CORS headers"
    info "  $cdn/$INCOMING_PREFIX$HEALTHCHECK_FILE answers 403"
    info "  $s3/$PUBLIC_PREFIX$HEALTHCHECK_FILE answers 403"
    info "  HeadObject --checksum-mode ENABLED returns ChecksumSHA256"
    info "  a PutObject whose body does not match its signed SHA-256 is refused"
    info "then delete the test objects and point to the app-user checks in README.md"
    return
  fi
  if [[ $DIST_STATUS != Deployed ]]; then
    warn "distribution $DIST_ID is $DIST_STATUS, so some edges may not serve it yet"
  fi
  printf 'public evidence healthcheck %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMP/$HEALTHCHECK_FILE"
  put_test_object "$PUBLIC_PREFIX$HEALTHCHECK_FILE"
  put_test_object "$INCOMING_PREFIX$HEALTHCHECK_FILE"

  check_status "CloudFront public object" "$cdn/$PUBLIC_PREFIX$HEALTHCHECK_FILE" 200 18
  expect_header x-content-type-options nosniff
  expect_header referrer-policy no-referrer
  expect_header content-security-policy "$CSP"
  expect_header access-control-allow-origin "${CDN_ORIGINS[0]}"
  expect_header_prefix strict-transport-security "max-age=$HSTS_MAX_AGE"
  check_status "CloudFront incoming object" "$cdn/$INCOMING_PREFIX$HEALTHCHECK_FILE" 403
  check_status "direct S3 public object" "$s3/$PUBLIC_PREFIX$HEALTHCHECK_FILE" 403
  check_checksum_head "$INCOMING_PREFIX$HEALTHCHECK_FILE"
  check_checksum_mismatch

  delete_test_objects
  step "App-user checks to run by hand"
  info "They need the app user's own key. Follow \"App-user checks\" in scripts/aws/README.md with:"
  info "  KEY_FILE=${KEY_OUT:-<the --key-out file>} BUCKET=$BUCKET REGION=$REGION DIST_ID=$DIST_ID"
  if (( FAILURES )); then
    die "$FAILURES verify check(s) failed"
  fi
  step "All verify checks passed"
}

on_exit() {
  local rc=$? key
  for key in ${CLEANUP_KEYS[@]+"${CLEANUP_KEYS[@]}"}; do
    "${AWS[@]}" s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1 || warn "could not delete s3://$BUCKET/$key"
  done
  rm -rf "$TMP"
  exit "$rc"
}

usage() {
  cat <<'EOF'
Usage: scripts/aws/public-evidence-setup.sh [options]

Creates, or brings up to date, what the app needs to serve public evidence:
the IAM user, its inline policy and access key, S3 CORS, lifecycle and bucket
policy, and the CloudFront origin access control, response headers policy and
distribution. Every step reads first and writes only what is missing.

Options:
  --profile NAME     AWS CLI profile to run as (default: the CLI's default chain)
  --bucket NAME      S3 bucket (default: kane-cli-hack-day)
  --region REGION    bucket region (default: us-east-1)
  --user-name NAME   IAM user that signs uploads (default: <bucket>-public-evidence)
  --key-out FILE     where a new access key is written (required when one is created, never overwritten)
  --dry-run          run every read, print every write and its JSON, change nothing
  --verify           after setup, upload test objects and check CloudFront and S3 answers
  --no-wait          don't wait for the CloudFront distribution to deploy
  --force-cors       keep a CORS configuration this script didn't write and add our rule ahead of it
  -h, --help         show this help
EOF
}

# JSON documents

# HEAD with checksum mode and both sides of CopyObject need only s3:GetObject and s3:PutObject, so no s3:GetObjectAttributes.
build_user_policy() {
  cat >"$1" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EvidenceObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": ["$BUCKET_ARN/$INCOMING_PREFIX*", "$BUCKET_ARN/$PUBLIC_PREFIX*"]
    },
    {
      "Sid": "EvidenceListForNotFound",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "$BUCKET_ARN",
      "Condition": {"StringLike": {"s3:prefix": ["$INCOMING_PREFIX*", "$PUBLIC_PREFIX*"]}}
    },
    {
      "Sid": "EvidenceCacheInvalidation",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "$DIST_ARN"
    }
  ]
}
EOF
  json_check "$1" || die "generated an invalid IAM policy"
}

build_cors() {
  cat >"$1" <<EOF
{
  "CORSRules": [
    {
      "ID": "$CORS_RULE_ID",
      "AllowedOrigins": $(json_list "${UPLOAD_ORIGINS[@]}"),
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": $(json_list "${UPLOAD_HEADERS[@]}"),
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": $CORS_MAX_AGE
    }
  ]
}
EOF
  json_check "$1" || die "generated an invalid CORS configuration"
}

build_lifecycle() {
  cat >"$1" <<EOF
{
  "Rules": [
    {
      "ID": "$LIFECYCLE_EXPIRE_ID",
      "Status": "Enabled",
      "Filter": {"Prefix": "$INCOMING_PREFIX"},
      "Expiration": {"Days": 1}
    },
    {
      "ID": "$LIFECYCLE_ABORT_ID",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}
    }
  ]
}
EOF
  json_check "$1" || die "generated an invalid lifecycle configuration"
}

build_oac() {
  cat >"$1" <<EOF
{
  "Name": "$OAC_NAME",
  "Description": "CloudFront reads $BUCKET public evidence",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}
EOF
  json_check "$1" || die "generated an invalid origin access control config"
}

# AllowHeaders only shapes preflight answers, and this behaviour never allows OPTIONS.
build_headers_policy() {
  cat >"$1" <<EOF
{
  "Name": "$HEADERS_POLICY_NAME",
  "Comment": "Security and CORS headers for $BUCKET public evidence",
  "CorsConfig": {
    "AccessControlAllowOrigins": {"Quantity": ${#CDN_ORIGINS[@]}, "Items": $(json_list "${CDN_ORIGINS[@]}")},
    "AccessControlAllowHeaders": {"Quantity": 1, "Items": ["*"]},
    "AccessControlAllowMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    "AccessControlAllowCredentials": false,
    "AccessControlMaxAgeSec": $CORS_MAX_AGE,
    "OriginOverride": true
  },
  "SecurityHeadersConfig": {
    "ContentTypeOptions": {"Override": true},
    "ReferrerPolicy": {"ReferrerPolicy": "no-referrer", "Override": true},
    "StrictTransportSecurity": {"AccessControlMaxAgeSec": $HSTS_MAX_AGE, "IncludeSubdomains": true, "Preload": false, "Override": true},
    "ContentSecurityPolicy": {"ContentSecurityPolicy": "$CSP", "Override": true}
  }
}
EOF
  json_check "$1" || die "generated an invalid response headers policy"
}

build_distribution() {
  cat >"$1" <<EOF
{
  "CallerReference": "$BUCKET-public-evidence-$(date +%s)",
  "Comment": "$DIST_COMMENT",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "$ORIGIN_ID",
        "DomainName": "$ORIGIN_DOMAIN",
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "S3OriginConfig": {"OriginAccessIdentity": ""},
        "OriginAccessControlId": "$OAC_ID"
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "$ORIGIN_ID",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}
    },
    "Compress": true,
    "CachePolicyId": "$CACHE_POLICY_ID",
    "ResponseHeadersPolicyId": "$HEADERS_POLICY_ID"
  },
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "ViewerCertificate": {"CloudFrontDefaultCertificate": true}
}
EOF
  json_check "$1" || die "generated an invalid distribution config"
}

build_bucket_policy() {
  cat >"$1" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "$POLICY_SID_CDN_READ",
      "Effect": "Allow",
      "Principal": {"Service": "cloudfront.amazonaws.com"},
      "Action": "s3:GetObject",
      "Resource": "$BUCKET_ARN/$PUBLIC_PREFIX*",
      "Condition": {"StringEquals": {"AWS:SourceArn": "$2"}}
    },
    {
      "Sid": "$POLICY_SID_TLS_ONLY",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["$BUCKET_ARN", "$BUCKET_ARN/*"],
      "Condition": {"Bool": {"aws:SecureTransport": "false"}}
    }
  ]
}
EOF
  json_check "$1" || die "generated an invalid bucket policy"
}

# JSON helpers: jq when installed, python3 -I otherwise.

json_engine_init() {
  if command -v jq >/dev/null 2>&1; then
    JSON=jq
  elif command -v python3 >/dev/null 2>&1; then
    JSON=python3
  else
    die "need jq or python3 to handle JSON"
  fi
}

json_check() {
  if [[ $JSON == jq ]]; then
    jq empty "$1" 2>/dev/null
  else
    python3 -I -c 'import json, sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
  fi
}

json_pretty() {
  if [[ $JSON == jq ]]; then
    jq . "$1"
  else
    python3 -I -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1])), indent=2))' "$1"
  fi
}

json_same() {
  if [[ $JSON == jq ]]; then
    [[ "$(jq -S -c . "$1")" == "$(jq -S -c . "$2")" ]]
  else
    python3 -I -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])) else 1)' "$1" "$2"
  fi
}

# Prints the merged CORS config. Exits 3 when other rules exist and FORCE is 0, 4 when nothing would change.
json_merge_cors() {
  if [[ $JSON == jq ]]; then
    jq -n --slurpfile cur "$1" --slurpfile want "$2" --argjson force "$3" '
      $want[0].CORSRules as $ours | [$ours[].ID] as $ids | ($cur[0].CORSRules // []) as $old
      | [$old[] | select(.ID as $id | $ids | all(. != $id))] as $other
      | if ($other | length) > 0 and $force == 0 then
          ("    existing CORS rules not written by this script: " + ([$other[] | .ID // "(no ID)"] | join(", ")) + "\n") | halt_error(3)
        elif ($ours + $other) == $old then "" | halt_error(4)
        else {CORSRules: ($ours + $other)} end'
  else
    python3 -I -c '
import json, sys
old = json.load(open(sys.argv[1])).get("CORSRules", [])
ours = json.load(open(sys.argv[2]))["CORSRules"]
ids = [r["ID"] for r in ours]
other = [r for r in old if r.get("ID") not in ids]
if other and sys.argv[3] == "0":
    sys.stderr.write("    existing CORS rules not written by this script: " + ", ".join(r.get("ID", "(no ID)") for r in other) + "\n")
    sys.exit(3)
if ours + other == old:
    sys.exit(4)
print(json.dumps({"CORSRules": ours + other}, indent=2))
' "$1" "$2" "$3"
  fi
}

# Prints the merged lifecycle config with our rules replaced by ID. Exits 4 when nothing would change.
json_merge_lifecycle() {
  if [[ $JSON == jq ]]; then
    jq -n --slurpfile cur "$1" --slurpfile want "$2" '
      $want[0].Rules as $ours | [$ours[].ID] as $ids | ($cur[0].Rules // []) as $old
      | ([$old[] | select(.ID as $id | $ids | all(. != $id))] + $ours) as $rules
      | if $rules == $old then "" | halt_error(4) else {Rules: $rules} end'
  else
    python3 -I -c '
import json, sys
old = json.load(open(sys.argv[1])).get("Rules", [])
ours = json.load(open(sys.argv[2]))["Rules"]
ids = [r["ID"] for r in ours]
rules = [r for r in old if r.get("ID") not in ids] + ours
if rules == old:
    sys.exit(4)
print(json.dumps({"Rules": rules}, indent=2))
' "$1" "$2"
  fi
}

# Prints the merged bucket policy with our statements replaced by Sid. Exits 3 when ambiguous, 4 when nothing would change.
json_merge_policy() {
  if [[ $JSON == jq ]]; then
    jq -n --slurpfile cur "$1" --slurpfile want "$2" '
      def fail(m): ("    " + m + "\n") | halt_error(3);
      $cur[0] as $p | $want[0].Statement as $ours | [$ours[].Sid] as $sids
      | ($p.Statement | if type == "array" then . elif . == null then [] else [.] end) as $old
      | [$old[].Sid | select(. != null)] as $oldsids
      | if $p.Version != "2012-10-17" then fail("the policy Version is \($p.Version), not 2012-10-17")
        elif ($oldsids | length) != ($oldsids | unique | length) then fail("the policy has duplicate Sids")
        elif any($old[]; . as $s | any($ours[]; .Sid == $s.Sid and .Effect != $s.Effect)) then
          fail("a statement uses one of this script'"'"'s Sids (\($sids | join(", "))) with a different Effect")
        else ([$old[] | select(.Sid as $s | $sids | all(. != $s))] + $ours) as $stmts
          | if $stmts == $old then "" | halt_error(4) else ($p | .Statement = $stmts) end
        end'
  else
    python3 -I -c '
import json, sys
p = json.load(open(sys.argv[1]))
ours = json.load(open(sys.argv[2]))["Statement"]
sids = [s["Sid"] for s in ours]
old = p.get("Statement", [])
old = old if isinstance(old, list) else [old]
oldsids = [s["Sid"] for s in old if s.get("Sid") is not None]
def fail(m):
    sys.stderr.write("    " + m + "\n")
    sys.exit(3)
if p.get("Version") != "2012-10-17":
    fail("the policy Version is %s, not 2012-10-17" % p.get("Version"))
if len(oldsids) != len(set(oldsids)):
    fail("the policy has duplicate Sids")
if any(s.get("Sid") == o["Sid"] and s.get("Effect") != o["Effect"] for s in old for o in ours):
    fail("a statement uses one of this script'"'"'s Sids (%s) with a different Effect" % ", ".join(sids))
stmts = [s for s in old if s.get("Sid") not in sids] + ours
if stmts == old:
    sys.exit(4)
p["Statement"] = stmts
print(json.dumps(p, indent=2))
' "$1" "$2"
  fi
}

json_list() {
  local out="" item
  for item in "$@"; do
    out+="${out:+, }\"$item\""
  done
  printf '[%s]' "$out"
}

# AWS helpers

# Sets OUT to the text result. Returns 1 when the error code is MISSING, dies on any other error.
aws_get() {
  local missing=$1
  shift
  if "${AWS[@]}" "$@" --output text >"$TMP/out" 2>"$TMP/stderr"; then
    OUT=$(cat "$TMP/out")
    return 0
  fi
  if [[ -n $missing ]] && grep -q "($missing)" "$TMP/stderr"; then
    return 1
  fi
  die "aws $1 $2 failed: $(tr -s '\n' ' ' <"$TMP/stderr")"
}

# Writes the JSON result to FILE. Returns 1 when the error code is MISSING, dies on any other error.
aws_get_json() {
  local file=$1 missing=$2
  shift 2
  if "${AWS[@]}" "$@" --output json >"$file" 2>"$TMP/stderr"; then
    return 0
  fi
  rm -f "$file"
  if [[ -n $missing ]] && grep -q "($missing)" "$TMP/stderr"; then
    return 1
  fi
  die "aws $1 $2 failed: $(tr -s '\n' ' ' <"$TMP/stderr")"
}

# Sets OUT to one line per match of a projection query. Text output applies --query to each page, so never use length() or [0] here.
aws_list() {
  aws_get "" "$@"
  OUT=$(grep -v -x -e None -e '' <<<"$OUT" || true)
}

line_count() {
  grep -c . <<<"$1" || true
}

one_line() {
  tr '\t\n' ' ,' <<<"$1" | sed 's/,$//'
}

# Logs a write with the JSON files it sends, then runs it unless --dry-run. Sets WRITE_OUT to its output.
run_write() {
  local desc=$1 arg
  shift
  WRITES=$((WRITES + 1))
  WRITE_OUT=""
  info "$desc"
  printf '      $' >&2
  printf ' %q' "${AWS[@]}" "$@" >&2
  printf '\n' >&2
  for arg in "$@"; do
    if [[ $arg == file://* ]]; then
      json_pretty "${arg#file://}" | sed 's/^/        /' >&2
    fi
  done
  if (( DRY_RUN )); then
    info "(dry run: skipped)"
    return 0
  fi
  "${AWS[@]}" "$@" >"$TMP/write-out" || die "aws $1 $2 failed"
  WRITE_OUT=$(cat "$TMP/write-out")
}

# Claims the file before the key exists, so a file that appeared since preflight can't cost a secret.
write_access_key() {
  (umask 077 && set -o noclobber && : >"$KEY_OUT") 2>/dev/null || die "cannot create $KEY_OUT: it exists or its directory is read-only"
  if ! "${AWS[@]}" iam create-access-key --user-name "$USER_NAME" --output text \
      --query "[join('', ['EVIDENCE_S3_ACCESS_KEY_ID=', AccessKey.AccessKeyId]), join('', ['EVIDENCE_S3_SECRET_ACCESS_KEY=', AccessKey.SecretAccessKey])]" \
      | tr '\t' '\n' >>"$KEY_OUT"; then
    if [[ ! -s $KEY_OUT ]]; then
      rm -f "$KEY_OUT"
    fi
    die "could not create the access key or write $KEY_OUT"
  fi
  chmod 600 "$KEY_OUT"
}

put_test_object() {
  CLEANUP_KEYS+=("$1")
  "${AWS[@]}" s3api put-object --bucket "$BUCKET" --key "$1" --body "$TMP/$HEALTHCHECK_FILE" \
    --content-type text/plain --checksum-algorithm SHA256 >/dev/null || die "could not put s3://$BUCKET/$1"
  info "put s3://$BUCKET/$1"
}

delete_test_objects() {
  local key
  for key in ${CLEANUP_KEYS[@]+"${CLEANUP_KEYS[@]}"}; do
    "${AWS[@]}" s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null || warn "could not delete s3://$BUCKET/$key"
  done
  CLEANUP_KEYS=()
  info "deleted the test objects"
}

check_checksum_head() {
  local sum
  sum=$("${AWS[@]}" s3api head-object --bucket "$BUCKET" --key "$1" --checksum-mode ENABLED \
    --query ChecksumSHA256 --output text 2>"$TMP/stderr") || sum=""
  if [[ -n $sum && $sum != None ]]; then
    pass "HeadObject --checksum-mode ENABLED returns ChecksumSHA256 $sum"
  else
    fail "HeadObject --checksum-mode ENABLED returned no ChecksumSHA256 $(tr -s '\n' ' ' <"$TMP/stderr")"
  fi
}

# S3 checks a signed x-amz-checksum-sha256 the same way for a presigned PUT, so a wrong body must be refused here too.
check_checksum_mismatch() {
  local key=$INCOMING_PREFIX$MISMATCH_FILE
  CLEANUP_KEYS+=("$key")
  if "${AWS[@]}" s3api put-object --bucket "$BUCKET" --key "$key" --body "$TMP/$HEALTHCHECK_FILE" \
      --content-type text/plain --checksum-sha256 "$EMPTY_SHA256_B64" >/dev/null 2>"$TMP/stderr"; then
    fail "PutObject with a mismatched x-amz-checksum-sha256 was accepted"
  elif grep -q -E '\((BadDigest|XAmzContentChecksumMismatch)\)' "$TMP/stderr"; then
    pass "PutObject with a mismatched x-amz-checksum-sha256 refused: $(grep -o -E 'BadDigest|XAmzContentChecksumMismatch' "$TMP/stderr" | head -n 1)"
  else
    fail "PutObject with a mismatched checksum failed with another error: $(tr -s '\n' ' ' <"$TMP/stderr")"
  fi
}

# Passes when URL answers WANT, retrying 10 seconds apart up to TRIES times.
check_status() {
  local label=$1 url=$2 want=$3 tries=${4:-1} code=000 i
  for (( i = 1; i <= tries; i++ )); do
    code=$(curl -sS --max-time 20 -o /dev/null -D "$TMP/headers" -w '%{http_code}' \
      -H "Origin: ${CDN_ORIGINS[0]}" "$url" 2>/dev/null) || code=000
    if [[ $code == "$want" ]] || (( i == tries )); then
      break
    fi
    sleep 10
  done
  if [[ $code == "$want" ]]; then
    pass "$label: HTTP $code ($url)"
  else
    fail "$label: HTTP $code, want $want ($url)"
  fi
}

header_value() {
  awk -v name="$2" 'tolower($0) ~ "^" name ":" { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); print; exit }' "$1"
}

expect_header() {
  local got
  got=$(header_value "$TMP/headers" "$1")
  if [[ $got == "$2" ]]; then
    pass "$1: $got"
  else
    fail "$1: '${got:-<missing>}', want '$2'"
  fi
}

expect_header_prefix() {
  local got
  got=$(header_value "$TMP/headers" "$1")
  if [[ $got == "$2"* ]]; then
    pass "$1: $got"
  else
    fail "$1: '${got:-<missing>}', want '$2...'"
  fi
}

expect_setting() {
  if [[ $2 != "$3" ]]; then
    warn "distribution $1 is '$2', not '$3'. Left unchanged."
  fi
}

fail_or_warn() {
  if (( DRY_RUN )); then
    warn "$1 (the real run stops here)"
  else
    die "$1"
  fi
}

set_option() {
  case $1 in
    --profile) PROFILE=$2 ;;
    --bucket) BUCKET=$2 ;;
    --region) REGION=$2 ;;
    --user-name) USER_NAME=$2 ;;
    --key-out) KEY_OUT=$2 ;;
  esac
}

step() { printf '\n==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
pass() { printf '    PASS  %s\n' "$*" >&2; }
fail() { printf '    FAIL  %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
