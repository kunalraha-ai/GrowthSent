#!/usr/bin/env bash
# Batch task entrypoint. It receives only immutable job fields and a Secret
# Manager *version name*; no R2 credential is written to this script/logs.
set -Eeuo pipefail
umask 077

readonly ROOT=/opt/growthsent
readonly PYTHON="${PYTHON:-python}"
readonly MANIFEST_ROOT="$ROOT/manifests"
readonly RELEASE_LOCK="$ROOT/RELEASE-ARCHIVE-SHA256"
readonly SHARD_FILE="$MANIFEST_ROOT/shards/$(printf 'shard-%05d-of-%05d.json' "$GROWTHSENT_SHARD_ID" "$GROWTHSENT_SHARD_COUNT")"

required=(
  GROWTHSENT_R2_RAW_PUBLISH_SECRET_VERSION GROWTHSENT_RELEASE_SHA256
  GROWTHSENT_RUN_ID GROWTHSENT_CRAWL GROWTHSENT_SHARD_ID GROWTHSENT_SHARD_COUNT
  GROWTHSENT_EXPECTED_INPUT_COUNT GROWTHSENT_BASE_INPUTS_SHA256
  GROWTHSENT_BASE_MANIFEST_SHA256 GROWTHSENT_SHARD_INPUTS_SHA256
  GROWTHSENT_SHARD_MANIFEST_SHA256 GROWTHSENT_RAW_PREFIX GROWTHSENT_DERIVED_PREFIX
  GROWTHSENT_BATCH_ATTEMPT GROWTHSENT_WORK_DIR
)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing immutable job setting: $name" >&2; exit 2; }; done
[[ "$GROWTHSENT_RUN_ID" == "cc-main-2026-30-offset-10000-count-25000" ]] || exit 2
[[ "$GROWTHSENT_SHARD_COUNT" == 25 && "$GROWTHSENT_SHARD_ID" =~ ^[0-9]+$ && "$GROWTHSENT_SHARD_ID" -ge 0 && "$GROWTHSENT_SHARD_ID" -lt 25 ]] || exit 2
[[ -r "$RELEASE_LOCK" && "$(tr -d '\r\n' < "$RELEASE_LOCK")" == "$GROWTHSENT_RELEASE_SHA256" ]] || { echo "container release lock does not match reviewed job release" >&2; exit 2; }

mkdir -p "$GROWTHSENT_WORK_DIR/output"
takeover_args=()
if [[ "${GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER:-}" == "true" ]]; then
  takeover_args=(--allow-expired-lease-takeover)
elif [[ -n "${GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER:-}" ]]; then
  echo "GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER must be exactly true when supplied" >&2
  exit 2
fi
exec "$PYTHON" "$ROOT/tools/common_crawl_gcp_secret_runtime.py" \
  --r2-secret-version "$GROWTHSENT_R2_RAW_PUBLISH_SECRET_VERSION" \
  --r2-credential-prefix GROWTHSENT_R2_ -- \
  "$PYTHON" "$ROOT/tools/common_crawl_wat_ingest_gcp_25k.py" \
  --base-manifest "$MANIFEST_ROOT/base-manifest.json" --shard-manifest "$SHARD_FILE" --shard-plan "$MANIFEST_ROOT/shards/shard-plan.json" \
  --run-id "$GROWTHSENT_RUN_ID" --crawl "$GROWTHSENT_CRAWL" --shard-id "$GROWTHSENT_SHARD_ID" --shard-count "$GROWTHSENT_SHARD_COUNT" \
  --expected-input-count "$GROWTHSENT_EXPECTED_INPUT_COUNT" --base-inputs-sha256 "$GROWTHSENT_BASE_INPUTS_SHA256" \
  --base-manifest-sha256 "$GROWTHSENT_BASE_MANIFEST_SHA256" --shard-inputs-sha256 "$GROWTHSENT_SHARD_INPUTS_SHA256" \
  --shard-manifest-sha256 "$GROWTHSENT_SHARD_MANIFEST_SHA256" --raw-prefix "$GROWTHSENT_RAW_PREFIX" --derived-prefix "$GROWTHSENT_DERIVED_PREFIX" \
  --release-sha256 "$GROWTHSENT_RELEASE_SHA256" --shard-lease-owner "$GROWTHSENT_BATCH_ATTEMPT" "${takeover_args[@]}" \
  --workers "${GROWTHSENT_RAW_WORKERS:-1}" --output-dir "$GROWTHSENT_WORK_DIR/output"
