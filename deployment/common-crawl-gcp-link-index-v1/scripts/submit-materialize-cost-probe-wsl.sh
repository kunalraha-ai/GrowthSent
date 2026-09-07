#!/usr/bin/env bash
# Submit one production-shaped, 1,000-source materialization cost probe.
# The script is intentionally launch-blocked until the immutable catalog exists
# and us-central1 has enough balanced-PD quota for this one 375 GB scratch disk.
set -euo pipefail
set +x

APPROVED=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: submit-materialize-cost-probe-wsl.sh [--dry-run | --approved-materialize-cost-probe]

--dry-run                         Validate the full remote launch contract without creating a Batch job.
--approved-materialize-cost-probe Create one fresh, immutable 1,000-source Batch probe after all checks pass.
USAGE
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --approved-materialize-cost-probe) APPROVED=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${DRY_RUN}" == true && "${APPROVED}" == true ]]; then
  printf 'Choose either --dry-run or --approved-materialize-cost-probe, not both.\n' >&2
  exit 2
fi
if [[ "${DRY_RUN}" != true && "${APPROVED}" != true ]]; then
  printf 'This launcher is non-destructive by default. Pass --dry-run or --approved-materialize-cost-probe.\n' >&2
  exit 2
fi

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
SECRET_ID="${GROWTHSENT_R2_READ_SECRET_ID:-r2-link-index-input-read}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
RELEASE_SHA256="${GROWTHSENT_MATERIALIZE_RELEASE_SHA256:-}"
SOURCE_START="${GROWTHSENT_MATERIALIZE_PROBE_SOURCE_START:-50000}"
SOURCE_COUNT=1000
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
CATALOG_OBJECT="${GROWTHSENT_CATALOG_OBJECT:-catalogs/v1/cc-main-2026-30/source-links-catalog.json}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../batch/materialize-cost-probe-job.template.json"
STAMP="$(date -u +%Y%m%d%H%M%S)"
RUN_ID="cc-main-2026-30-index-probe-${STAMP}-${RANDOM}"
JOB_ID="growthsent-link-index-probe-v1-${STAMP}"
OUTPUT_PREFIX="link-index/v1/cost-probes/${RUN_ID}"
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
[[ -f "${TEMPLATE}" ]] || { printf 'Missing cost-probe template: %s\n' "${TEMPLATE}" >&2; exit 1; }
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Set GROWTHSENT_MATERIALIZE_RELEASE_SHA256 to the reviewed 64-character build release SHA-256.\n' >&2
  exit 2
}
[[ "${SOURCE_START}" =~ ^[0-9]+$ ]] && (( SOURCE_START + SOURCE_COUNT <= 100000 )) || {
  printf 'GROWTHSENT_MATERIALIZE_PROBE_SOURCE_START must select exactly 1,000 locked source identities.\n' >&2
  exit 2
}

CATALOG_GENERATION="$(gcloud storage objects describe "gs://${GCS_BUCKET}/${CATALOG_OBJECT}" --project "${PROJECT_ID}" --format='value(generation)' 2>/dev/null || true)"
[[ "${CATALOG_GENERATION}" =~ ^[0-9]+$ ]] || {
  printf 'The immutable catalog is not present. Wait for catalog verification before launching this probe.\n' >&2
  exit 1
}

SECRET_STATE="$(gcloud secrets versions describe latest --secret "${SECRET_ID}" --project "${PROJECT_ID}" --format='value(state)')"
[[ "${SECRET_STATE}" == "ENABLED" ]] || {
  printf 'The latest %s Secret Manager version is not enabled.\n' "${SECRET_ID}" >&2
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
    printf 'Need %s available %s for the probe; quota is total=%s, used=%s.\n' "${needed}" "${metric}" "${total}" "${used}" >&2
    exit 1
  }
}
require_regional_quota "CPUS" 4
require_regional_quota "INSTANCES" 1
require_regional_quota "SSD_TOTAL_GB" 375

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"
IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
IMAGE_URI="${IMAGE_TAG%@*}@${IMAGE_DIGEST}"
[[ "${IMAGE_URI}" =~ ^us-central1-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$ ]] || {
  printf 'The selected probe image was not a valid digest-pinned us-central1 Artifact Registry image.\n' >&2
  exit 1
}

sed \
  -e "s|REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE|${IMAGE_URI}|g" \
  -e "s|REPLACE_WITH_RELEASE_SHA256|${RELEASE_SHA256}|g" \
  -e "s|REPLACE_WITH_NEW_INDEX_RUN_ID|${RUN_ID}|g" \
  -e "s|REPLACE_WITH_FRESH_OUTPUT_PREFIX|${OUTPUT_PREFIX}|g" \
  -e "s|REPLACE_WITH_SOURCE_START|${SOURCE_START}|g" \
  "${TEMPLATE}" > "${CONFIG}"
if grep -q 'REPLACE_WITH_' "${CONFIG}"; then
  printf 'Cost-probe job template still has an unresolved placeholder.\n' >&2
  exit 1
fi
jq -e '
  .labels == {"system":"growthsent-link-index","stage":"materialize-cost-probe","crawl":"cc-main-2026-30"} and
  .taskGroups[0].taskCount == 1 and
  .taskGroups[0].parallelism == 1 and
  .taskGroups[0].taskSpec.maxRetryCount == 0 and
  .taskGroups[0].taskSpec.maxRunDuration == "43200s" and
  .taskGroups[0].taskSpec.volumes == [{"deviceName":"scratch","mountPath":"/mnt/disks/scratch","mountOptions":"rw,async"}] and
  .taskGroups[0].taskSpec.computeResource == {"cpuMilli":4000,"memoryMib":30000} and
  .taskGroups[0].taskSpec.environment.variables.GROWTHSENT_WORK_DIR == "/mnt/disks/scratch/growthsent" and
  .taskGroups[0].taskSpec.environment.variables.GROWTHSENT_SOURCE_COUNT == "1000" and
  .allocationPolicy.instances[0].policy.machineType == "n2-highmem-4" and
  .allocationPolicy.instances[0].policy.disks == [{"newDisk":{"sizeGb":375,"type":"pd-balanced"},"deviceName":"scratch"}]
' "${CONFIG}" >/dev/null || {
  printf 'Cost-probe configuration does not match the reviewed resource and safety contract.\n' >&2
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
  printf 'A GrowthSent Batch job is already active; do not overlap the cost probe: %s\n' "${ACTIVE_GROWTHSENT_JOBS}" >&2
  exit 1
}

if [[ "${DRY_RUN}" == true ]]; then
  jq -nc \
    --arg job_id "${JOB_ID}" \
    --arg run_id "${RUN_ID}" \
    --arg output_prefix "${OUTPUT_PREFIX}" \
    --arg image "${IMAGE_URI}" \
    '{status:"launch_contract_verified", dry_run:true, job_id:$job_id, run_id:$run_id, output_prefix:$output_prefix, image:$image, source_count:1000}'
  exit 0
fi

gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","run_id":"%s","source_start":%s,"source_count":%s,"output_prefix":"%s","stage":"materialize-cost-probe"}\n' \
  "${JOB_ID}" "${RUN_ID}" "${SOURCE_START}" "${SOURCE_COUNT}" "${OUTPUT_PREFIX}"
