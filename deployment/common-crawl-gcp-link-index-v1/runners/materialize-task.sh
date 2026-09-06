#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT=/opt/growthsent
readonly PYTHON="${PYTHON:-python}"
readonly RELEASE_LOCK="$ROOT/RELEASE-SHA256"
readonly task_index="${BATCH_TASK_INDEX:-0}"
readonly task_count="${BATCH_TASK_COUNT:-1}"

required=(
  GROWTHSENT_RELEASE_SHA256
  GROWTHSENT_R2_INPUT_READ_SECRET_VERSION
  GROWTHSENT_GCS_BUCKET
  GROWTHSENT_CATALOG_OBJECT
  GROWTHSENT_INDEX_RUN_ID
  GROWTHSENT_OUTPUT_PREFIX
  GROWTHSENT_WORK_DIR
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required setting: $name" >&2; exit 2; }
done
[[ "$GROWTHSENT_R2_INPUT_READ_SECRET_VERSION" == projects/*/versions/* ]] || { echo "R2 secret must be a Secret Manager version resource" >&2; exit 2; }
[[ "$GROWTHSENT_INDEX_RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "index run ID must be a lowercase slug" >&2; exit 2; }
[[ "$GROWTHSENT_OUTPUT_PREFIX" != /* && "$GROWTHSENT_OUTPUT_PREFIX" != *".."* ]] || { echo "output prefix is unsafe" >&2; exit 2; }
[[ -r "$RELEASE_LOCK" && "$(tr -d '\r\n' < "$RELEASE_LOCK")" == "$GROWTHSENT_RELEASE_SHA256" ]] || { echo "container release lock does not match reviewed job release" >&2; exit 2; }

source_start="${GROWTHSENT_SOURCE_START:-$((task_index * ${GROWTHSENT_SOURCE_COUNT_PER_TASK:-1000}))}"
source_count="${GROWTHSENT_SOURCE_COUNT:-${GROWTHSENT_SOURCE_COUNT_PER_TASK:-1000}}"
[[ "$source_start" =~ ^[0-9]+$ && "$source_count" =~ ^[1-9][0-9]*$ ]] || { echo "source selection is invalid" >&2; exit 2; }
mkdir -p "$GROWTHSENT_WORK_DIR"

exec "$PYTHON" "$ROOT/tools/common_crawl_gcp_secret_runtime.py" \
  --r2-secret-version "$GROWTHSENT_R2_INPUT_READ_SECRET_VERSION" \
  --r2-credential-prefix GROWTHSENT_R2_INPUT_READ_ -- \
  "$PYTHON" "$ROOT/tools/common_crawl_link_index_materialize_v1.py" \
  --source-manifest "$ROOT/manifests/cc-main-2026-30-first-100000.json" \
  --gcs-bucket "$GROWTHSENT_GCS_BUCKET" \
  --catalog-object "$GROWTHSENT_CATALOG_OBJECT" \
  --run-id "$GROWTHSENT_INDEX_RUN_ID" \
  --output-prefix "$GROWTHSENT_OUTPUT_PREFIX" \
  --source-start "$source_start" \
  --source-count "$source_count" \
  --shard-id "$task_index" \
  --shard-count "$task_count" \
  --work-dir "$GROWTHSENT_WORK_DIR"
