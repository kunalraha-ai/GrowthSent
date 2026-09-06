#!/usr/bin/env bash
# Build and publish the digest-pinned link-index image through Cloud Build.
# This WSL-native launcher does not require local Docker.
set -euo pipefail
set +x

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
REGION="${GROWTHSENT_GCP_REGION:-us-central1}"
REPOSITORY="${GROWTHSENT_GCP_REPOSITORY:-growthsent-containers}"
IMAGE_NAME="${GROWTHSENT_GCP_IMAGE_NAME:-link-index-v1}"
PYTHON_IMAGE="${GROWTHSENT_GCP_PYTHON_IMAGE:-python@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
CLOUDBUILD_CONFIG="${ROOT_DIR}/deployment/common-crawl-gcp-link-index-v1/container/cloudbuild.yaml"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_command find
require_command gcloud
require_command sha256sum
require_command sort
[[ -f "${CLOUDBUILD_CONFIG}" ]] || {
  printf 'Missing Cloud Build configuration: %s\n' "${CLOUDBUILD_CONFIG}" >&2
  exit 1
}

RELEASE_ROOTS=(
  "tools/common_crawl_r2_store.py"
  "tools/common_crawl_gcp_secret_runtime.py"
  "tools/common_crawl_link_index_catalog_v1.py"
  "tools/common_crawl_link_index_materialize_v1.py"
  "tools/common_crawl_link_index_compact_v1.py"
  "deployment/common-crawl-gcp-link-index-v1"
  "deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json"
)

HASH_LINES="$({
  for relative_path in "${RELEASE_ROOTS[@]}"; do
    path="${ROOT_DIR}/${relative_path}"
    if [[ -d "${path}" ]]; then
      find "${path}" -type f -print0
    elif [[ -f "${path}" ]]; then
      printf '%s\0' "${path}"
    else
      printf 'Required release path is missing: %s\n' "${relative_path}" >&2
      exit 1
    fi
  done
} | while IFS= read -r -d '' file; do sha256sum "${file}" | awk '{print $1}'; done | LC_ALL=C sort)"

[[ -n "${HASH_LINES}" ]] || {
  printf 'No release files were found.\n' >&2
  exit 1
}
RELEASE_SHA256="$(printf '%s\n' "${HASH_LINES}" | sha256sum | awk '{print $1}')"
REGISTRY_HOST="${REGION}-docker.pkg.dev"
TAG="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${RELEASE_SHA256}"

gcloud builds submit "${ROOT_DIR}" \
  --project "${PROJECT_ID}" \
  --config "${CLOUDBUILD_CONFIG}" \
  --substitutions "_IMAGE_URI=${TAG},_PYTHON_IMAGE=${PYTHON_IMAGE},_GROWTHSENT_RELEASE_SHA256=${RELEASE_SHA256}" \
  --quiet

IMAGE_DIGEST="$(gcloud artifacts docker images describe "${TAG}" --project "${PROJECT_ID}" --format='value(image_summary.digest)')"
[[ "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'Artifact Registry did not return a digest-pinned image.\n' >&2
  exit 1
}

printf '{"status":"published","release_sha256":"%s","image":"%s@%s"}\n' \
  "${RELEASE_SHA256}" "${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}" "${IMAGE_DIGEST}"
