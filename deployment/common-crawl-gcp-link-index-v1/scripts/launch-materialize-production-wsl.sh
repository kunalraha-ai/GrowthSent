#!/usr/bin/env bash
# Build, digest-pin, preflight, and explicitly submit full 100K materialization.
set -euo pipefail
set +x

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: launch-materialize-production-wsl.sh --approved-materialize-production [submit-options]

Builds the current release, resolves its immutable image digest, verifies the
complete 100K catalog and capacity contract, then submits one fresh 100-task
Batch materialization job.

Use GROWTHSENT_MATERIALIZE_PARALLELISM=50 to scale up once quota is approved.
Use --resume-run-id and --resume-output-prefix to continue a previous run without
reprocessing its finished task manifests.

Pass the approval flag only when ready to allocate up to the requested number of
n2-highmem-4 VMs and transient pd-balanced disk.
USAGE
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD_LOG="$(mktemp)"

cleanup() {
  rm -f -- "${BUILD_LOG}"
}
trap cleanup EXIT

bash "${SCRIPT_DIR}/build-image-wsl.sh" | tee "${BUILD_LOG}"
RELEASE_SHA256="$(tail -n 1 "${BUILD_LOG}" | jq -er 'select(.status == "published") | .release_sha256')"
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Build did not return a valid reviewed release SHA-256.\n' >&2
  exit 1
}

GROWTHSENT_MATERIALIZE_RELEASE_SHA256="${RELEASE_SHA256}" \
  bash "${SCRIPT_DIR}/submit-materialize-production-wsl.sh" "$@"
