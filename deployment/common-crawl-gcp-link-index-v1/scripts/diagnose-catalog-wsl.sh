#!/usr/bin/env bash
# Print concise Cloud Batch task failures for one link-index catalog job.
set -euo pipefail
set +x

JOB_ID="${1:-}"
PROJECT_ID="${GROWTHSENT_GCP_PROJECT_ID:-growthsent-link-index}"
LOCATION="${GROWTHSENT_GCP_LOCATION:-us-central1}"

[[ "${JOB_ID}" =~ ^growthsent-link-index-catalog-v1-[0-9]{14}$ ]] || {
  printf 'Usage: %s growthsent-link-index-catalog-v1-YYYYMMDDHHMMSS\n' "$0" >&2
  exit 2
}
command -v gcloud >/dev/null 2>&1 || {
  printf 'Missing required command: gcloud\n' >&2
  exit 1
}

JOB_UID="$(gcloud batch jobs describe "${JOB_ID}" --project "${PROJECT_ID}" --location "${LOCATION}" --format='value(uid)')"
[[ -n "${JOB_UID}" ]] || {
  printf 'Could not resolve a Batch job UID.\n' >&2
  exit 1
}

gcloud logging read \
  "logName=\"projects/${PROJECT_ID}/logs/batch_task_logs\" AND labels.job_uid=\"${JOB_UID}\"" \
  --project "${PROJECT_ID}" \
  --limit 20 \
  --order desc \
  --format='value(timestamp,jsonPayload.status,jsonPayload.error,textPayload)'
