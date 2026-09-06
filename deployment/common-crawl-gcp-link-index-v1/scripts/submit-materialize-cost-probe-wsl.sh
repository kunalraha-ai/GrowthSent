#!/usr/bin/env bash
# Submit one production-shaped, 1,000-source materialization cost probe.
# The script is intentionally launch-blocked until the immutable catalog exists
# and us-central1 has enough balanced-PD quota for this one 375 GB scratch disk.
set -euo pipefail
set +x

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

SSD_TOTAL_GB="$(gcloud compute regions describe "${REGION}" --project "${PROJECT_ID}" --format=json | jq -r '.quotas[] | select(.metric == "SSD_TOTAL_GB") | .limit')"
SSD_USED_GB="$(gcloud compute regions describe "${REGION}" --project "${PROJECT_ID}" --format=json | jq -r '.quotas[] | select(.metric == "SSD_TOTAL_GB") | .usage')"
[[ "${SSD_TOTAL_GB}" =~ ^[0-9]+([.][0-9]+)?$ && "${SSD_USED_GB}" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  printf 'Could not determine regional SSD_TOTAL_GB quota.\n' >&2
  exit 1
}
awk -v total="${SSD_TOTAL_GB}" -v used="${SSD_USED_GB}" 'BEGIN { exit ((total - used) >= 375 ? 0 : 1) }' || {
  printf 'Need 375 GB available SSD_TOTAL_GB for the probe; quota is total=%s GB, used=%s GB.\n' "${SSD_TOTAL_GB}" "${SSD_USED_GB}" >&2
  exit 1
}

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

gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","run_id":"%s","source_start":%s,"source_count":%s,"output_prefix":"%s","stage":"materialize-cost-probe"}\n' \
  "${JOB_ID}" "${RUN_ID}" "${SOURCE_START}" "${SOURCE_COUNT}" "${OUTPUT_PREFIX}"
