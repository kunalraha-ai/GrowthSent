#!/usr/bin/env bash
# Submit the metadata-only R2 completion-artifact catalog job from WSL.
# Override the pinned build only after publishing a replacement image:
#   GROWTHSENT_CATALOG_IMAGE_URI=... GROWTHSENT_CATALOG_RELEASE_SHA256=... bash .../submit-catalog-wsl.sh
set -euo pipefail
set +x

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
SECRET_ID="${GROWTHSENT_R2_READ_SECRET_ID:-r2-link-index-input-read}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
IMAGE_URI_OVERRIDE="${GROWTHSENT_CATALOG_IMAGE_URI:-}"
RELEASE_SHA256="${GROWTHSENT_CATALOG_RELEASE_SHA256:-1297fca94d6363ab6c482f1747a58abfe5828e0353e35e7defefc67169ea2ddb}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../batch/catalog-job.template.json"
JOB_ID="growthsent-link-index-catalog-v1-$(date -u +%Y%m%d%H%M%S)"
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
require_command sed
[[ -f "${TEMPLATE}" ]] || {
  printf 'Missing catalog job template: %s\n' "${TEMPLATE}" >&2
  exit 1
}
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'GROWTHSENT_CATALOG_RELEASE_SHA256 must be a SHA-256 digest.\n' >&2
  exit 1
}

if [[ -n "${IMAGE_URI_OVERRIDE}" ]]; then
  IMAGE_URI="${IMAGE_URI_OVERRIDE}"
else
  IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"
  IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
  IMAGE_URI="${IMAGE_TAG%@*}@${IMAGE_DIGEST}"
fi
[[ "${IMAGE_URI}" =~ ^us-central1-docker\.pkg\.dev/.+@sha256:[0-9a-f]{64}$ ]] || {
  printf 'The selected catalog image was not a valid digest-pinned us-central1 Artifact Registry image.\n' >&2
  exit 1
}

SECRET_STATE="$(gcloud secrets versions describe latest --secret "${SECRET_ID}" --project "${PROJECT_ID}" --format='value(state)')"
[[ "${SECRET_STATE}" == "ENABLED" ]] || {
  printf 'The latest %s version is not enabled.\n' "${SECRET_ID}" >&2
  exit 1
}

sed \
  -e "s|REPLACE_WITH_DIGEST_PINNED_ARTIFACT_REGISTRY_IMAGE|${IMAGE_URI}|g" \
  -e "s|REPLACE_WITH_RELEASE_SHA256|${RELEASE_SHA256}|g" \
  "${TEMPLATE}" > "${CONFIG}"
if grep -q 'REPLACE_WITH_' "${CONFIG}"; then
  printf 'Catalog job template still has an unresolved placeholder.\n' >&2
  exit 1
fi

gcloud batch jobs submit "${JOB_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --config "${CONFIG}" \
  --quiet

printf '{"status":"submitted","job_id":"%s","project":"%s","location":"%s","stage":"catalog"}\n' \
  "${JOB_ID}" "${PROJECT_ID}" "${LOCATION}"
