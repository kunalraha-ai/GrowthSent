#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT=/opt/growthsent
readonly PYTHON="${PYTHON:-python}"
readonly RELEASE_LOCK="$ROOT/RELEASE-SHA256"
readonly task_index="${BATCH_TASK_INDEX:-0}"
readonly target_bucket="${GROWTHSENT_TARGET_BUCKET:-$task_index}"

required=(
  GROWTHSENT_RELEASE_SHA256
  GROWTHSENT_R2_OUTPUT_WRITE_SECRET_VERSION
  GROWTHSENT_BUCKET
  GROWTHSENT_SERVING_PREFIX
  GROWTHSENT_OUTPUT_PREFIX
  GROWTHSENT_WORK_DIR
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required setting: $name" >&2; exit 2; }
done
[[ "$GROWTHSENT_R2_OUTPUT_WRITE_SECRET_VERSION" == projects/*/versions/* ]] || { echo "R2 secret must be a Secret Manager version resource" >&2; exit 2; }
[[ "$target_bucket" =~ ^[0-9]+$ && "$target_bucket" -lt 1024 ]] || { echo "target bucket must be 0-1023" >&2; exit 2; }
[[ -r "$RELEASE_LOCK" && "$(tr -d '\r\n' < "$RELEASE_LOCK")" == "$GROWTHSENT_RELEASE_SHA256" ]] || { echo "container release lock does not match reviewed job release" >&2; exit 2; }
mkdir -p "$GROWTHSENT_WORK_DIR"

exec "$PYTHON" "$ROOT/tools/common_crawl_gcp_secret_runtime.py" \
  --r2-secret-version "$GROWTHSENT_R2_OUTPUT_WRITE_SECRET_VERSION" \
  --r2-credential-prefix GROWTHSENT_R2_OUTPUT_ -- \
  "$PYTHON" "$ROOT/tools/build_domain_json_v1.py" \
  --bucket "$target_bucket" \
  --serving-prefix "$GROWTHSENT_SERVING_PREFIX" \
  --output-prefix "$GROWTHSENT_OUTPUT_PREFIX" \
  --work-dir "$GROWTHSENT_WORK_DIR" \
  --top-n "${GROWTHSENT_TOP_N:-100}" \
  --upload-threads "${GROWTHSENT_UPLOAD_THREADS:-64}" \
  --batch-size "${GROWTHSENT_BATCH_SIZE:-2048}"
