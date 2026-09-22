#!/usr/bin/env bash
# Submit the verified 100,000-source link-index materialization job.
# This is launch-blocked until the immutable catalog, scoped credential, fresh
# output prefix, idle Batch control plane, and requested N2 capacity are proven.
set -euo pipefail
set +x

APPROVED=false
DRY_RUN=false
RESUME_RUN_ID=""
RESUME_OUTPUT_PREFIX=""

usage() {
  cat <<'USAGE'
Usage: submit-materialize-production-wsl.sh [--dry-run | --approved-materialize-production] [--resume-run-id ID --resume-output-prefix PREFIX]

--dry-run                              Validate the complete 100K launch contract without creating a Batch job.
--approved-materialize-production      Submit one fresh 100-task Batch materialization job after all checks pass.
--resume-run-id ID                     Reuse an existing run ID so already-completed task manifests are skipped.
--resume-output-prefix PREFIX          Reuse the existing output prefix from the previous run.

Environment:
  GROWTHSENT_MATERIALIZE_PARALLELISM   Max concurrent workers (default 25). Use 50 after N2 quota is approved.
USAGE
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --approved-materialize-production) APPROVED=true ;;
    --resume-run-id)
      shift
      [[ -n "${1:-}" ]] || { printf '--resume-run-id requires a value.\n' >&2; exit 2; }
      RESUME_RUN_ID="$1"
      ;;
    --resume-output-prefix)
      shift
      [[ -n "${1:-}" ]] || { printf '--resume-output-prefix requires a value.\n' >&2; exit 2; }
      RESUME_OUTPUT_PREFIX="$1"
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${DRY_RUN}" == true && "${APPROVED}" == true ]]; then
  printf 'Choose either --dry-run or --approved-materialize-production, not both.\n' >&2
  exit 2
fi
if [[ "${DRY_RUN}" != true && "${APPROVED}" != true ]]; then
  printf 'This launcher is non-destructive by default. Pass --dry-run or --approved-materialize-production.\n' >&2
  exit 2
fi
if [[ -n "${RESUME_RUN_ID}" && -z "${RESUME_OUTPUT_PREFIX}" ]] || [[ -z "${RESUME_RUN_ID}" && -n "${RESUME_OUTPUT_PREFIX}" ]]; then
  printf '--resume-run-id and --resume-output-prefix must be provided together.\n' >&2
  exit 2
fi

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
SECRET_ID="${GROWTHSENT_R2_READ_SECRET_ID:-r2-link-index-input-read}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
RELEASE_SHA256="${GROWTHSENT_MATERIALIZE_RELEASE_SHA256:-}"
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
CATALOG_OBJECT="${GROWTHSENT_CATALOG_OBJECT:-catalogs/v1/cc-main-2026-30/source-links-catalog.json}"

readonly TASK_COUNT=100
readonly PARALLELISM="${GROWTHSENT_MATERIALIZE_PARALLELISM:-25}"
if [[ ! "${PARALLELISM}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'GROWTHSENT_MATERIALIZE_PARALLELISM must be a positive integer.\n' >&2
  exit 2
fi
readonly SOURCE_COUNT_PER_TASK=1000
readonly CPU_PER_TASK=8
readonly SCRATCH_GB_PER_TASK=375
readonly INSTANCE_COUNT="${PARALLELISM}"
readonly CPU_NEEDED="$((PARALLELISM * CPU_PER_TASK))"
readonly SSD_GB_NEEDED="$((PARALLELISM * SCRATCH_GB_PER_TASK))"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../batch/materialize-production-job.template.json"
STAMP="$(date -u +%Y%m%d%H%M%S)"

if [[ -n "${RESUME_RUN_ID}" ]]; then
  RUN_ID="${RESUME_RUN_ID}"
  OUTPUT_PREFIX="${RESUME_OUTPUT_PREFIX}"
  JOB_ID="growthsent-link-index-materialize-resume-v1-${STAMP}"
else
  RUN_ID="cc-main-2026-30-index-materialize-${STAMP}-${RANDOM}"
  OUTPUT_PREFIX="link-index/v1/materializations/${RUN_ID}"
  JOB_ID="growthsent-link-index-materialize-v1-${STAMP}"
fi
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
[[ -f "${TEMPLATE}" ]] || { printf 'Missing production materialization template: %s\n' "${TEMPLATE}" >&2; exit 1; }
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Set GROWTHSENT_MATERIALIZE_RELEASE_SHA256 to the reviewed 64-character build release SHA-256.\n' >&2
  exit 2
}
[[ "${CATALOG_OBJECT}" != /* && "${CATALOG_OBJECT}" != *".."* ]] || {
  printf 'Catalog object path is invalid.\n' >&2
  exit 2
}

# The catalog verifier checks the locked source manifest, all 100,000 source
# identities, source roots, link artifact identity, and the catalog hash before
# any production capacity is allocated.
CATALOG_PROOF="$(bash "${SCRIPT_DIR}/verify-catalog-wsl.sh")"
jq -e '
  .kind == "growthsent-cc-main-2026-30-links-catalog-v1" and
  .source_identity_count == 100000 and
  .distinct_links_artifact_count == 100000 and
  (.catalog_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
' <<<"${CATALOG_PROOF}" >/dev/null || {
  printf 'The immutable catalog proof is not a valid complete 100K catalog.\n' >&2
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
    printf 'Need %s available %s for 100K materialization; quota is total=%s, used=%s.\n' "${needed}" "${metric}" "${total}" "${used}" >&2
    exit 1
  }
}
require_regional_quota "CPUS" "${CPU_NEEDED}"
require_regional_quota "N2_CPUS" "${CPU_NEEDED}"
require_regional_quota "INSTANCES" "${INSTANCE_COUNT}"
# Balanced Persistent Disk uses the regional SSD_TOTAL_GB capacity quota.
require_regional_quota "SSD_TOTAL_GB" "${SSD_GB_NEEDED}"

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"
IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
IMAGE_URI="${IMAGE_TAG%@*}@${IMAGE_DIGEST}"
[[ "${IMAGE_URI}" =~ ^${REGION}-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$ ]] || {
  printf 'The selected image was not a valid digest-pinned Artifact Registry image.\n' >&2
  exit 1
}

if [[ -z "${RESUME_OUTPUT_PREFIX}" ]]; then
  # A timestamp-and-random-suffixed prefix should be new. List defensively and
  # refuse to schedule if any object is already present.
  EXISTING_OUTPUT="$(gcloud storage ls "gs://${GCS_BUCKET}/${OUTPUT_PREFIX}/**" --project "${PROJECT_ID}" 2>/dev/null || true)"
  [[ -z "${EXISTING_OUTPUT}" ]] || {
    printf 'Refusing to reuse a materialization output prefix: %s\n' "${OUTPUT_PREFIX}" >&2
    exit 1
  }
fi

sed \
  -e "s|REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE|${IMAGE_URI}|g" \
  -e "s|REPLACE_WITH_RELEASE_SHA256|${RELEASE_SHA256}|g" \
  -e "s|REPLACE_WITH_NEW_INDEX_RUN_ID|${RUN_ID}|g" \
  -e "s|REPLACE_WITH_FRESH_OUTPUT_PREFIX|${OUTPUT_PREFIX}|g" \
  -e "s|REPLACE_WITH_PARALLELISM|${PARALLELISM}|g" \
  "${TEMPLATE}" > "${CONFIG}"
if grep -q 'REPLACE_WITH_' "${CONFIG}"; then
  printf 'Production materialization template still has an unresolved placeholder.\n' >&2
  exit 1
fi

jq -e \
  --argjson parallelism "${PARALLELISM}" '
  .labels == {"system":"growthsent-link-index","stage":"materialize","crawl":"cc-main-2026-30"} and
  .taskGroups[0].taskCount == 100 and
  .taskGroups[0].parallelism == $parallelism and
  .taskGroups[0].taskSpec.maxRetryCount == 1 and
  .taskGroups[0].taskSpec.maxRunDuration == "43200s" and
  .taskGroups[0].taskSpec.volumes == [{"deviceName":"scratch","mountPath":"/mnt/disks/scratch","mountOptions":"rw,async"}] and
  .taskGroups[0].taskSpec.computeResource == {"cpuMilli":4000,"memoryMib":30000} and
  .taskGroups[0].taskSpec.environment.variables.GROWTHSENT_WORK_DIR == "/mnt/disks/scratch/growthsent" and
  .taskGroups[0].taskSpec.environment.variables.GROWTHSENT_SOURCE_COUNT_PER_TASK == "1000" and
  (.taskGroups[0].taskSpec.environment.variables | has("GROWTHSENT_SOURCE_START") | not) and
  .allocationPolicy.instances[0].policy.machineType == "c2d-highmem-4" and
  .allocationPolicy.instances[0].policy.disks == [{"newDisk":{"sizeGb":375,"type":"pd-balanced"},"deviceName":"scratch"}]
' "${CONFIG}" >/dev/null || {
  printf 'Production configuration does not match the reviewed 100-task / %d-way safety contract.\n' "${PARALLELISM}" >&2
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
  printf 'A GrowthSent Batch job is already active; do not overlap production materialization: %s\n' "${ACTIVE_GROWTHSENT_JOBS}" >&2
  exit 1
}

if [[ "${DRY_RUN}" == true ]]; then
  jq -nc \
    --arg job_id "${JOB_ID}" \
    --arg run_id "${RUN_ID}" \
    --arg output_prefix "${OUTPUT_PREFIX}" \
    --arg image "${IMAGE_URI}" \
    --arg catalog_sha256 "$(jq -r '.catalog_sha256' <<<"${CATALOG_PROOF}")" \
    --argjson parallelism "${PARALLELISM}" \
    --argjson scratch_gb "${SSD_GB_NEEDED}" \
    --argjson resume "$([[ -n "${RESUME_RUN_ID}" ]] && echo true || echo false)" \
    '{status:"launch_contract_verified",dry_run:true,job_id:$job_id,run_id:$run_id,output_prefix:$output_prefix,image:$image,catalog_sha256:$catalog_sha256,task_count:100,parallelism:$parallelism,source_count:100000,resume:$resume,required:{cpus:($parallelism * 4),instances:$parallelism,balanced_pd_gb:$scratch_gb}}'
  exit 0
fi

gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","run_id":"%s","output_prefix":"%s","task_count":100,"parallelism":%d,"source_count":100000,"resume":%s,"stage":"materialize"}\n' \
  "${JOB_ID}" "${RUN_ID}" "${OUTPUT_PREFIX}" "${PARALLELISM}" "$([[ -n "${RESUME_RUN_ID}" ]] && echo true || echo false)"
