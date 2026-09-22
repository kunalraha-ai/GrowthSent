#!/usr/bin/env bash
# Submit the verified 100-shard link-index compaction job.
# Reads the completed materialization prefix and writes domain-serving tables.
set -euo pipefail
set +x

APPROVED=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: submit-compact-production-wsl.sh [--dry-run | --approved-compact-production]

--dry-run                        Validate the full compaction launch contract without creating a Batch job.
--approved-compact-production    Submit the 1,024-bucket compaction job after all checks pass.

Environment:
  GROWTHSENT_COMPACT_RELEASE_SHA256      Required. The 64-character release SHA pinned in the container.
  GROWTHSENT_MATERIALIZE_OUTPUT_PREFIX   Input materialization prefix (no trailing slash).
                                         Default: link-index/v1/materializations/cc-main-2026-30-index-materialize-20260907080000-17418
  GROWTHSENT_COMPACT_PARALLELISM         Max concurrent workers (default 25).
  GROWTHSENT_GCP_PROJECT_ID            Default: growthsent-link-index
  GROWTHSENT_GCP_LOCATION                Default: us-central1
  GROWTHSENT_GCP_REGION                  Default: us-central1
  GROWTHSENT_GCS_BUCKET                  Default: growthsent-link-index-498930285709
  GROWTHSENT_GCP_REPOSITORY              Default: growthsent-containers
  GROWTHSENT_GCP_IMAGE_NAME              Default: link-index-v1
USAGE
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --approved-compact-production) APPROVED=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${DRY_RUN}" == true && "${APPROVED}" == true ]]; then
  printf 'Choose either --dry-run or --approved-compact-production, not both.\n' >&2
  exit 2
fi
if [[ "${DRY_RUN}" != true && "${APPROVED}" != true ]]; then
  printf 'This launcher is non-destructive by default. Pass --dry-run or --approved-compact-production.\n' >&2
  exit 2
fi

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
RELEASE_SHA256="${GROWTHSENT_COMPACT_RELEASE_SHA256:-}"
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
MATERIALIZE_PREFIX="${GROWTHSENT_MATERIALIZE_OUTPUT_PREFIX:-link-index/v1/materializations/cc-main-2026-30-index-materialize-20260907080000-17418}"

readonly TASK_COUNT=1024
readonly PARALLELISM="${GROWTHSENT_COMPACT_PARALLELISM:-25}"
if [[ ! "${PARALLELISM}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'GROWTHSENT_COMPACT_PARALLELISM must be a positive integer.\n' >&2
  exit 2
fi
readonly CPU_PER_TASK=4
readonly SCRATCH_GB_PER_TASK=1000
readonly INSTANCE_COUNT="${PARALLELISM}"
readonly CPU_NEEDED="$((PARALLELISM * CPU_PER_TASK))"
readonly SSD_GB_NEEDED="$((PARALLELISM * SCRATCH_GB_PER_TASK))"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../batch/compact-production-job.template.json"
STAMP="$(date -u +%Y%m%d%H%M%S)"
RUN_ID="cc-main-2026-30-index-compact-${STAMP}-${RANDOM}"
OUTPUT_PREFIX="link-index/v1/serving/${RUN_ID}"
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
[[ -f "${TEMPLATE}" ]] || { printf 'Missing production compaction template: %s\n' "${TEMPLATE}" >&2; exit 1; }
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Set GROWTHSENT_COMPACT_RELEASE_SHA256 to the reviewed 64-character build release SHA-256.\n' >&2
  exit 2
}
[[ "${MATERIALIZE_PREFIX}" != /* && "${MATERIALIZE_PREFIX}" != *".."* ]] || {
  printf 'Materialization output prefix is unsafe.\n' >&2
  exit 2
}

# Prove the materialization stage is complete before we commit to 1,024 compact tasks.
MANIFEST_COUNT="$(gcloud storage ls "gs://${GCS_BUCKET}/${MATERIALIZE_PREFIX%/}/task-manifests/*.json" --project "${PROJECT_ID}" 2>/dev/null | wc -l)"
[[ "${MANIFEST_COUNT}" -eq 100 ]] || {
  printf 'Expected 100 materialization task manifests, found %s. Do not compact an incomplete materialization.\n' "${MANIFEST_COUNT}" >&2
  exit 1
}

REGION_QUOTAS="$(gcloud compute regions describe "${REGION}" --project "${PROJECT_ID}" --format=json)"
require_regional_quota() {
  local metric="$1"
  local needed="$2"
  local total used
  total="$(jq -r --arg metric "${metric}" '.quotas[] | select(.metric == $metric) | .limit' <<<"${REGION_QUOTAS}")"
  used="$(jq -r --arg metric "${metric}" '.quotas[] | select(.metric == $metric) | .usage' <<<"${REGION_QUOTAS}")"
  [[ "${total}" =~ ^[0-9]+([.][0-9]+)?$ && "${used}" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
    printf 'Could not determine regional %s quota.\n' "${metric}" >&2
    exit 1
  }
  awk -v total="${total}" -v used="${used}" -v needed="${needed}" 'BEGIN { exit ((total - used) >= needed ? 0 : 1) }' || {
    printf 'Need %s available %s for compaction; quota is total=%s, used=%s.\n' "${needed}" "${metric}" "${total}" "${used}" >&2
    exit 1
  }
}
require_regional_quota "CPUS" "${CPU_NEEDED}"
require_regional_quota "N2_CPUS" "${CPU_NEEDED}"
require_regional_quota "INSTANCES" "${INSTANCE_COUNT}"
require_regional_quota "SSD_TOTAL_GB" "${SSD_GB_NEEDED}"

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"
IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
IMAGE_URI="${IMAGE_TAG%@*}@${IMAGE_DIGEST}"
[[ "${IMAGE_URI}" =~ ^${REGION}-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$ ]] || {
  printf 'The selected image was not a valid digest-pinned Artifact Registry image.\n' >&2
  exit 1
}

EXISTING_OUTPUT="$(gcloud storage ls "gs://${GCS_BUCKET}/${OUTPUT_PREFIX}/**" --project "${PROJECT_ID}" 2>/dev/null || true)"
[[ -z "${EXISTING_OUTPUT}" ]] || {
  printf 'Refusing to reuse a compaction output prefix: %s\n' "${OUTPUT_PREFIX}" >&2
  exit 1
}

sed \
  -e "s|REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE|${IMAGE_URI}|g" \
  -e "s|REPLACE_WITH_RELEASE_SHA256|${RELEASE_SHA256}|g" \
  -e "s|REPLACE_WITH_NEW_COMPACTION_RUN_ID|${RUN_ID}|g" \
  -e "s|REPLACE_WITH_COMPLETE_MATERIALIZATION_PREFIX|${MATERIALIZE_PREFIX}|g" \
  -e "s|REPLACE_WITH_FRESH_SERVING_PREFIX|${OUTPUT_PREFIX}|g" \
  "${TEMPLATE}" > "${CONFIG}"
if grep -q 'REPLACE_WITH_' "${CONFIG}"; then
  printf 'Production compaction template still has an unresolved placeholder.\n' >&2
  exit 1
fi

jq -e \
  --argjson parallelism "${PARALLELISM}" '
  .labels == {"system":"growthsent-link-index","stage":"compact","crawl":"cc-main-2026-30"} and
  .taskGroups[0].taskCount == 1024 and
  .taskGroups[0].parallelism == $parallelism and
  .taskGroups[0].taskSpec.maxRetryCount == 1 and
  .taskGroups[0].taskSpec.maxRunDuration == "21600s" and
  .taskGroups[0].taskSpec.volumes == [{"deviceName":"scratch","mountPath":"/mnt/disks/scratch","mountOptions":"rw,async"}] and
  .taskGroups[0].taskSpec.computeResource == {"cpuMilli":4000,"memoryMib":30000} and
  .taskGroups[0].taskSpec.environment.variables.GROWTHSENT_WORK_DIR == "/mnt/disks/scratch/growthsent" and
  .allocationPolicy.instances[0].policy.machineType == "n2-highmem-4" and
  .allocationPolicy.instances[0].policy.disks == [{"newDisk":{"sizeGb":1000,"type":"pd-balanced"},"deviceName":"scratch"}]
' "${CONFIG}" >/dev/null || {
  printf 'Compaction configuration does not match the reviewed 1,024-bucket / %d-way safety contract.\n' "${PARALLELISM}" >&2
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
  printf 'A GrowthSent Batch job is already active; do not overlap production compaction: %s\n' "${ACTIVE_GROWTHSENT_JOBS}" >&2
  exit 1
}

if [[ "${DRY_RUN}" == true ]]; then
  jq -nc \
    --arg job_id "growthsent-link-index-compact-v1-${STAMP}" \
    --arg run_id "${RUN_ID}" \
    --arg output_prefix "${OUTPUT_PREFIX}" \
    --arg input_prefix "${MATERIALIZE_PREFIX}" \
    --arg image "${IMAGE_URI}" \
    --argjson parallelism "${PARALLELISM}" \
    --argjson scratch_gb "${SSD_GB_NEEDED}" \
    '{status:"launch_contract_verified",dry_run:true,job_id:$job_id,run_id:$run_id,input_prefix:$input_prefix,output_prefix:$output_prefix,image:$image,task_count:1024,parallelism:$parallelism,required:{cpus:($parallelism * 8),instances:$parallelism,balanced_pd_gb:$scratch_gb}}'
  exit 0
fi

JOB_ID="growthsent-link-index-compact-v1-${STAMP}"
gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","run_id":"%s","input_prefix":"%s","output_prefix":"%s","task_count":1024,"parallelism":%d,"stage":"compact"}\n' \
  "${JOB_ID}" "${RUN_ID}" "${MATERIALIZE_PREFIX}" "${OUTPUT_PREFIX}" "${PARALLELISM}"
