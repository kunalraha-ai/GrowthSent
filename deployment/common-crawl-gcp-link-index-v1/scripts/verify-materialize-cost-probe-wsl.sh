#!/usr/bin/env bash
# Read-only evidence check for a completed 1,000-source materialization cost probe.
set -euo pipefail
set +x

JOB_ID="${1:-}"
OUTPUT_PREFIX="${2:-}"
PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"
GCS_BUCKET="${GROWTHSENT_GCS_BUCKET:-growthsent-link-index-498930285709}"
SUMMARY_FILE="$(mktemp)"

cleanup() {
  rm -f -- "${SUMMARY_FILE}"
}
trap cleanup EXIT

[[ "${JOB_ID}" =~ ^growthsent-link-index-probe-v1-[0-9]{14}$ ]] || {
  printf 'Usage: %s growthsent-link-index-probe-v1-YYYYMMDDHHMMSS link-index/v1/cost-probes/RUN-ID\n' "$0" >&2
  exit 2
}
[[ -n "${OUTPUT_PREFIX}" && "${OUTPUT_PREFIX}" != /* && "${OUTPUT_PREFIX}" != *".."* ]] || {
  printf 'Output prefix is invalid.\n' >&2
  exit 2
}
command -v gcloud >/dev/null 2>&1 || { printf 'Missing required command: gcloud\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'Missing required command: jq\n' >&2; exit 1; }

STATE="$(gcloud batch jobs describe "${JOB_ID}" --project "${PROJECT_ID}" --location "${LOCATION}" --format='value(status.state)')"
[[ "${STATE}" == "SUCCEEDED" ]] || {
  printf 'Probe job is not successful (state=%s); no output is accepted as evidence.\n' "${STATE:-unknown}" >&2
  exit 1
}

SUMMARY_OBJECT="${OUTPUT_PREFIX%/}/task-manifests/shard=00000.json"
gcloud storage cat "gs://${GCS_BUCKET}/${SUMMARY_OBJECT}" --project "${PROJECT_ID}" > "${SUMMARY_FILE}"

jq -e '
  .kind == "growthsent-cc-main-2026-30-link-index-materialization-v1" and
  .source_count == 1000 and
  (.resource_observation.elapsed_seconds | type == "number" and . > 0) and
  (.resource_observation.source_links_bytes | type == "number" and . > 0) and
  (.resource_observation.artifact_total_bytes | type == "number" and . > 0) and
  (.resource_observation.scratch.filesystem_total_bytes | type == "number" and . > 0) and
  (.resource_observation.scratch.peak_incremental_bytes | type == "number" and . >= 0)
' "${SUMMARY_FILE}" >/dev/null || {
  printf 'Probe summary did not contain a valid 1,000-source resource observation.\n' >&2
  exit 1
}

jq -c --arg job_id "${JOB_ID}" --arg output_prefix "${OUTPUT_PREFIX%/}" '
  {
    status: "verified",
    job_id: $job_id,
    output_prefix: $output_prefix,
    source_count,
    resource_observation,
    table_row_counts
  }
' "${SUMMARY_FILE}"

printf 'Read-only disk follow-up: gcloud compute disks list --project %s --filter="zone~us-central1" --format="table(name,zone.basename(),sizeGb,type.basename(),status,users)"\n' "${PROJECT_ID}"
