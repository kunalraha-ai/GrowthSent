#!/usr/bin/env bash
# Native Ubuntu/WSL entrypoint. It does not invoke PowerShell.
set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "--preflight-only" && "$MODE" != "--approved-ten-wat-canary" ]] || [[ $# -ne 1 ]]; then
  echo "Usage: $0 --preflight-only|--approved-ten-wat-canary" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-/mnt/c/Users/kunal/AppData/Local/Temp/growthsent-cloudflare-10-wat-reference-v2/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for command in node npm npx python3 docker sha256sum; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done
[[ -f "$REFERENCE_MANIFEST" ]] || { echo "Missing reviewed public-source semantic baseline v2: $REFERENCE_MANIFEST" >&2; exit 1; }
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
CANARY_ID="${GROWTHSENT_CANARY_ID:-cc-main-2026-30-${TIMESTAMP}-10-wat-cf-${NONCE}}"
WORKER_NAME="${GROWTHSENT_WORKER_NAME:-growthsent-10wat-${NONCE}}"
BUNDLE_ROOT="$(mktemp -d -t "growthsent-cloudflare-10-wat-${CANARY_ID}-XXXXXX")"
BUNDLE_DIRECTORY="$BUNDLE_ROOT/bundle"

[[ "$CANARY_ID" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "The supplied canary ID must be a lowercase slug of at most 64 characters." >&2; exit 1; }
[[ "$WORKER_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "The supplied Worker name must be a lowercase slug of at most 63 characters." >&2; exit 1; }

echo "GrowthSent Cloudflare Container 10-WAT canary (Ubuntu/WSL native)"
echo "Canary ID: $CANARY_ID"
echo "R2 prefix: production/common-crawl/cloudflare-r2-canaries/v1/$CANARY_ID/"
echo "Reference baseline SHA-256: $(sha256sum "$REFERENCE_MANIFEST" | awk '{print $1}')"
if [[ "$MODE" == "--preflight-only" ]]; then
  echo "Mode: server-minted child credential preflight only; no Worker, Container, or R2 object will be created."
else
  echo "Scope: exactly ten public-source-baseline WATs, one Container instance, one HTTPS stream at a time, 110-minute hard timeout."
fi
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundle.py" \
  --run-id "$CANARY_ID" \
  --worker-name "$WORKER_NAME" \
  --container-name "$WORKER_NAME" \
  --reference-manifest "$REFERENCE_MANIFEST" \
  --output-dir "$BUNDLE_DIRECTORY"
npm --prefix "$BUNDLE_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev >/dev/null

# Keep boto3 (the exact R2 client used by the Container) isolated to this
# disposable bundle.  This works even when Ubuntu lacks the optional
# python3-venv package, and does not modify its system Python.
BOTO3_SITE_PACKAGES="$BUNDLE_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
if [[ -z "$PARENT_TOKEN" ]]; then
  echo "A parent Cloudflare API token is required." >&2
  exit 1
fi

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$BUNDLE_DIRECTORY/provision-and-start-wsl.mjs" "$MODE" "$BUNDLE_DIRECTORY"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Ubuntu/WSL provisioner failed. No additional start request was made." >&2
  exit "$RESULT"
fi
echo "Bundle context (no secrets): $BUNDLE_DIRECTORY/CANARY-CONTEXT.json"
