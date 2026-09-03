#!/usr/bin/env bash
# Read-only verification for a completed regional standard-1 capacity run.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--context" || ! -f "$2" ]]; then
  echo "Usage: $0 --context <REGIONAL-RAMP-CONTEXT.json|TEN-THOUSAND-RAMP-CONTEXT.json|HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json|HIGH-CAPACITY-TEN-THOUSAND-PARTIAL-RECOVERY-CONTEXT.json|ENAM-RECOVERY-CONTEXT.json|INCOMPLETE-RECOVERY-CONTEXT.json|REMAINING-RECOVERY-CONTEXT.json>" >&2
  exit 2
fi

CONTEXT="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

VERIFY_DIRECTORY="$(mktemp -d -t growthsent-cloudflare-standard1-regional-verify-XXXXXX)"
cp "$SCRIPT_DIR/verify-regional-ramp-wsl.mjs" "$VERIFY_DIRECTORY/verify-regional-ramp-wsl.mjs"
npm --prefix "$VERIFY_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

echo "GrowthSent regional standard-1 run read-only verification (Ubuntu/WSL native)"
echo "Context: $CONTEXT"
echo "Scope: exact R2 object and JSON-contract verification. No Worker, Container, or R2 object is changed."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | node "$VERIFY_DIRECTORY/verify-regional-ramp-wsl.mjs" "$CONTEXT" "$VERIFY_DIRECTORY"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Read-only regional capacity verification did not pass. No remote state was changed." >&2
  exit "$RESULT"
fi
echo "Secret-free verification report: $VERIFY_DIRECTORY/VERIFICATION-REPORT.json"
