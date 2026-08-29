#!/usr/bin/env bash
# Read-only post-run verifier for one Cloudflare Container ten-WAT canary.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--canary-id" ]] || ! [[ "$2" =~ ^cc-main-2026-30-[a-z0-9-]+$ ]]; then
  echo "Usage: $0 --canary-id <cc-main-2026-30-canary-id>" >&2
  exit 2
fi

CANARY_ID="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-/mnt/c/Users/kunal/AppData/Local/Temp/growthsent-cloudflare-10-wat-reference-v2/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"
AUDIT_MANIFEST_KEY="${GROWTHSENT_AUDIT_MANIFEST_KEY:-production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for command in node npm; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done
[[ -f "$REFERENCE_MANIFEST" ]] || { echo "Missing reviewed public-source semantic baseline v2: $REFERENCE_MANIFEST" >&2; exit 1; }
REFERENCE_MANIFEST_SHA256="$(sha256sum "$REFERENCE_MANIFEST" | awk '{print $1}')"
[[ "$REFERENCE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "The local baseline SHA-256 is invalid." >&2; exit 1; }

VERIFY_DIRECTORY="$(mktemp -d -t "growthsent-cloudflare-verify-${CANARY_ID}-XXXXXX")"
cp "$SCRIPT_DIR/verify-canary-wsl.mjs" "$VERIFY_DIRECTORY/verify-canary-wsl.mjs"
npm --prefix "$VERIFY_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

echo "GrowthSent Cloudflare Container 10-WAT read-only verification (Ubuntu/WSL native)"
echo "Canary ID: $CANARY_ID"
echo "Scope: read-only metadata and JSON verification for this canary prefix plus the immutable public-source baseline v2."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
if [[ -z "$PARENT_TOKEN" ]]; then
  echo "A parent Cloudflare API token is required." >&2
  exit 1
fi

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_AUDIT_MANIFEST_KEY="$AUDIT_MANIFEST_KEY" GROWTHSENT_AUDIT_MANIFEST_SHA256="$REFERENCE_MANIFEST_SHA256" node "$VERIFY_DIRECTORY/verify-canary-wsl.mjs" "$CANARY_ID" "$VERIFY_DIRECTORY"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Read-only verification did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi
echo "Local, secret-free verification report: $VERIFY_DIRECTORY/VERIFICATION-REPORT.json"
