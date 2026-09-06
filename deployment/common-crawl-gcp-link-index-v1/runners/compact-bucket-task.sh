#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT=/opt/growthsent
readonly PYTHON="${PYTHON:-python}"
readonly RELEASE_LOCK="$ROOT/RELEASE-SHA256"
readonly task_index="${BATCH_TASK_INDEX:-0}"

required=(
  GROWTHSENT_RELEASE_SHA256
  GROWTHSENT_GCS_BUCKET
  GROWTHSENT_COMPACTION_RUN_ID
  GROWTHSENT_INPUT_PREFIX
  GROWTHSENT_OUTPUT_PREFIX
  GROWTHSENT_WORK_DIR
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required setting: $name" >&2; exit 2; }
done
[[ "$GROWTHSENT_COMPACTION_RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "compaction run ID must be a lowercase slug" >&2; exit 2; }
[[ "$task_index" =~ ^[0-9]+$ && "$task_index" -lt 1024 ]] || { echo "Batch task index must be a target bucket" >&2; exit 2; }
[[ -r "$RELEASE_LOCK" && "$(tr -d '\r\n' < "$RELEASE_LOCK")" == "$GROWTHSENT_RELEASE_SHA256" ]] || { echo "container release lock does not match reviewed job release" >&2; exit 2; }
mkdir -p "$GROWTHSENT_WORK_DIR"

exec "$PYTHON" "$ROOT/tools/common_crawl_link_index_compact_v1.py" \
  --gcs-bucket "$GROWTHSENT_GCS_BUCKET" \
  --run-id "$GROWTHSENT_COMPACTION_RUN_ID" \
  --input-prefix "$GROWTHSENT_INPUT_PREFIX" \
  --output-prefix "$GROWTHSENT_OUTPUT_PREFIX" \
  --target-bucket "$task_index" \
  --work-dir "$GROWTHSENT_WORK_DIR"
