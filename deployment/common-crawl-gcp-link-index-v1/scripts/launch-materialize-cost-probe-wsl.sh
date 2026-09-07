#!/usr/bin/env bash
# Build, digest-pin, preflight, and explicitly submit one materialization probe.
set -euo pipefail
set +x

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: launch-materialize-cost-probe-wsl.sh --approved-materialize-cost-probe

Builds the current release, resolves its immutable image digest, runs every
remote launch preflight, and submits exactly one fresh 1,000-source probe.
Pass --approved-materialize-cost-probe only when ready to allocate the VM.
USAGE
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD_LOG="$(mktemp)"

cleanup() {
  rm -f -- "${BUILD_LOG}"
}
trap cleanup EXIT

# The build script emits human-readable Cloud Build output followed by exactly
# one JSON document. Keep the complete build transcript visible, then extract
# the reviewed release identity only from that final line.
bash "${SCRIPT_DIR}/build-image-wsl.sh" | tee "${BUILD_LOG}"
RELEASE_SHA256="$(tail -n 1 "${BUILD_LOG}" | jq -er 'select(.status == "published") | .release_sha256')"
[[ "${RELEASE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Build did not return a valid reviewed release SHA-256.\n' >&2
  exit 1
}

GROWTHSENT_MATERIALIZE_RELEASE_SHA256="${RELEASE_SHA256}" \
  bash "${SCRIPT_DIR}/submit-materialize-cost-probe-wsl.sh" "$@"
