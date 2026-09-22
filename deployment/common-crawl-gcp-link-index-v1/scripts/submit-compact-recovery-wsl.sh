#!/usr/bin/env bash
# Submit a one-bucket compaction recovery job into an existing serving prefix.
set -euo pipefail
set +x

APPROVED=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: submit-compact-recovery-wsl.sh [--dry-run | --approved-compact-recovery]

Recover one failed target bucket from an existing compaction run using a larger
worker and a higher DuckDB memory limit.

Required environment:
  GROWTHSENT_COMPACT_RECOVERY_TARGET_BUCKET  e.g. 196
  GROWTHSENT_COMPACT_RECOVERY_RUN_ID         Existing run ID (e.g. cc-main-2026-30-index-compact-20260911025127-497)
  GROWTHSENT_COMPACT_RECOVERY_INPUT_PREFIX   Existing materialization output prefix
  GROWTHSENT_COMPACT_RECOVERY_OUTPUT_PREFIX  Existing compaction serving prefix to publish into
  GROWTHSENT_COMPACT_RELEASE_SHA256          Build release SHA-256

Optional environment:
  GROWTHSENT_GCP_PROJECT_ID  Default: growthsent-link-index
  GROWTHSENT_GCP_LOCATION    Default: us-central1
  GROWTHSENT_GCP_REGION      Default: us-central1
  GROWTHSENT_GCS_BUCKET      Default: growthsent-link-index-498930285709
  GROWTHSENT_GCP_REPOSITORY    Default: growthsent-containers
  GROWTHSENT_GCP_IMAGE_NAME    Default: link-index-v1
  GROWTHSENT_COMPACT_RECOVERY_PARALLELISM  Default: 1
USAGE
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --approved-compact-recovery) APPROVED=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${DRY_RUN}" == true && "${APPROVED}" == true ]]; then
  printf 'Choose either --dry-run or --approved-compact-recovery, not both.\n' >&2
  exit 2
fi
if [[ "${DRY_RUN}" != true && "${APPROVED}" != true ]]; then
  printf 'This launcher is non-destructive by default. Pass --dry-run or --approved-compact-recovery.\n' >&2
  exit 2
fi

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
RELEASE_SHA256="${GROWTHSENT_COMPACT_RELEASE_SHA256:-}"

TARGET_BUCKET="${GROWTHSENT_COMPACT_RECOVERY_TARGET_BUCKET:-}"
RUN_ID="${GROWTHSENT_COMPACT_RECOVERY_RUN_ID:-}"
INPUT_PREFIX="${GROWTHSENT_COMPACT_RECOVERY_INPUT_PREFIX:-}"
OUTPUT_PREFIX="${GROWTHSENT_COMPACT_RECOVERY_OUTPUT_PREFIX:-}"

readonly TASK_COUNT=1
readonly PARALLELISM="${GROWTHSENT_COMPACT_RECOVERY_PARALLELISM:-1}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../batch/compact-recovery-job.template.json"
STAMP="$(date -u +%Y%m%d%H%M%S)"
JOB_ID="growthsent-link-index-compact-recovery-v1-${STAMP}"
CONFIG="$(mktemp)"

cleanup() {
  rm -f -- "${CONFIG}"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_command gcloud
require_command jq
require_command sed
require_command awk
[[ -f "${TEMPLATE}" ]] || { printf 'Missing recovery compaction template: %s\n' "${TEMPLATE}" >&2; exit 1; }

[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Set GROWTHSENT_COMPACT_RELEASE_SHA256 to the reviewed 64-character build release SHA-256.\n' >&2
  exit 2
}

[[ "${TARGET_BUCKET}" =~ ^[0-9]+$ && "${TARGET_BUCKET}" -ge 0 && "${TARGET_BUCKET}" -lt 1024 ]] || {
  printf 'GROWTHSENT_COMPACT_RECOVERY_TARGET_BUCKET must be an integer 0-1023.\n' >&2
  exit 2
}

[[ "${RUN_ID}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || {
  printf 'GROWTHSENT_COMPACT_RECOVERY_RUN_ID must be a lowercase slug.\n' >&2
  exit 2
}

for prefix in "${INPUT_PREFIX}" "${OUTPUT_PREFIX}"; do
  [[ -n "${prefix}" && "${prefix}" != /* && "${prefix}" != *".."* ]] || {
    printf 'Input/output prefix is unsafe or empty.\n' >&2
    exit 2
  }
done

# Do not accidentally overwrite an already-successful bucket.
EXISTING_MANIFEST="gs://${GCS_BUCKET}/${OUTPUT_PREFIX%/}/compaction-manifests/target_bucket=$(printf '%04d' "${TARGET_BUCKET}").json"
EXISTING_CHECK="$(gcloud storage ls "${EXISTING_MANIFEST}" --project "${PROJECT_ID}" 2>/dev/null || true)"
if [[ -n "${EXISTING_CHECK}" ]]; then
  printf 'Refusing to overwrite existing compaction manifest:\n  %s\n' "${EXISTING_MANIFEST}" >&2
  exit 1
fi

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"
IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
IMAGE_URI="${IMAGE_TAG%@*}@${IMAGE_DIGEST}"
[[ "${IMAGE_URI}" =~ ^${REGION}-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$ ]] || {
  printf 'The selected image was not a valid digest-pinned Artifact Registry image.\n' >&2
  exit 1
}

sed \
  -e "s|REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE|${IMAGE_URI}|g" \
  -e "s|REPLACE_WITH_RELEASE_SHA256|${RELEASE_SHA256}|g" \
  -e "s|REPLACE_WITH_EXISTING_COMPACTION_RUN_ID|${RUN_ID}|g" \
  -e "s|REPLACE_WITH_COMPLETE_MATERIALIZATION_PREFIX|${INPUT_PREFIX}|g" \
  -e "s|REPLACE_WITH_EXISTING_SERVING_PREFIX|${OUTPUT_PREFIX}|g" \
  -e "s|REPLACE_WITH_TARGET_BUCKET|${TARGET_BUCKET}|g" \
  "${TEMPLATE}" > "${CONFIG}"
if grep -q 'REPLACE_WITH_' "${CONFIG}"; then
  printf 'Recovery compaction template still has an unresolved placeholder.\n' >&2
  exit 1
fi

jq -e '
  .labels == {"system":"growthsent-link-index","stage":"compact-recovery","crawl":"cc-main-2026-30"} and
  .taskGroups[0].taskCount == 1 and
  .taskGroups[0].parallelism == 1 and
  .taskGroups[0].taskSpec.maxRetryCount == 1 and
  .taskGroups[0].taskSpec.maxRunDuration == "21600s" and
  .taskGroups[0].taskSpec.computeResource == {"cpuMilli":4000,"memoryMib":60000} and
  (.taskGroups[0].taskSpec.environment.variables.GROWTHSENT_TARGET_BUCKET | type == "string") and
  (.taskGroups[0].taskSpec.environment.variables.GROWTHSENT_DUCKDB_MEMORY_LIMIT == "55GB") and
  (.taskGroups[0].taskSpec.environment.variables.GROWTHSENT_DUCKDB_THREADS == "8") and
  .allocationPolicy.instances[0].policy.machineType == "n2-highmem-8" and
  .allocationPolicy.instances[0].policy.disks == [{"newDisk":{"sizeGb":1000,"type":"pd-balanced"},"deviceName":"scratch"}]
' "${CONFIG}" >/dev/null || {
  printf 'Recovery compaction configuration does not match the reviewed one-bucket safety contract.\n' >&2
  exit 1
}

ACTIVE_GROWTHSENT_JOBS="$(gcloud batch jobs list --project "${PROJECT_ID}" --location "${LOCATION}" --format=json | jq -c '
  [ .[]
    | select(.labels.system == "growthsent-link-index")
    | select(.status.state == "QUEUED" or .status.state == "SCHEDULED" or .status.state == "RUNNING")
    | {name, stage: .labels.stage, state: .status.state}
  ]
')"
[[ "${ACTIVE_GROWTHSENT_JOBS}" == "[]" ]] || {
  printf 'A GrowthSent Batch job is already active; do not overlap recovery compaction: %s\n' "${ACTIVE_GROWTHSENT_JOBS}" >&2
  exit 1
}

if [[ "${DRY_RUN}" == true ]]; then
  jq -nc \
    --arg job_id "${JOB_ID}" \
    --arg run_id "${RUN_ID}" \
    --arg input_prefix "${INPUT_PREFIX}" \
    --arg output_prefix "${OUTPUT_PREFIX}" \
    --arg bucket "${TARGET_BUCKET}" \
    --arg image "${IMAGE_URI}" \
    '{status:"recovery_launch_contract_verified",dry_run:true,job_id:$job_id,run_id:$run_id,input_prefix:$input_prefix,output_prefix:$output_prefix,target_bucket:$bucket,image:$image}'
  exit 0
fi

gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","run_id":"%s","target_bucket":"%s","input_prefix":"%s","output_prefix":"%s","stage":"compact-recovery"}\n' \
  "${JOB_ID}" "${RUN_ID}" "${TARGET_BUCKET}" "${INPUT_PREFIX}" "${OUTPUT_PREFIX}"
