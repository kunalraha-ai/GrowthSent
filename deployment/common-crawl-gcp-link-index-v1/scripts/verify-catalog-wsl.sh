#!/usr/bin/env bash
# Download and verify the immutable 100K source-to-links-artifact GCS catalog.
# This command is read-only: it never changes GCS, R2, Batch, or Secret Manager.
set -euo pipefail
set +x

PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
CATALOG_OBJECT="${GROWTHSENT_CATALOG_OBJECT:-catalogs/v1/cc-main-2026-30/source-links-catalog.json}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
CATALOG_FILE="$(mktemp)"

cleanup() {
  rm -f -- "${CATALOG_FILE}"
}
trap cleanup EXIT

command -v gcloud >/dev/null 2>&1 || { printf 'Missing required command: gcloud\n' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { printf 'Missing required command: python3\n' >&2; exit 1; }
[[ "${CATALOG_OBJECT}" != /* && "${CATALOG_OBJECT}" != *".."* ]] || {
  printf 'Catalog object path is invalid.\n' >&2
  exit 2
}

gcloud storage cat "gs://${GCS_BUCKET}/${CATALOG_OBJECT}" --project "${PROJECT_ID}" > "${CATALOG_FILE}"
python3 "${ROOT_DIR}/tools/verify_common_crawl_link_index_catalog_v1.py" \
  --catalog "${CATALOG_FILE}" \
  --source-manifest "${ROOT_DIR}/deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json" \
  --source-roots "${ROOT_DIR}/deployment/common-crawl-gcp-link-index-v1/config/source-roots.v1.json"
