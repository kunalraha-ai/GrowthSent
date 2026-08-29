#!/usr/bin/env bash
# Publish only the reviewed public-source v2 baseline into its isolated R2 audit prefix.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-/mnt/c/Users/kunal/AppData/Local/Temp/growthsent-cloudflare-10-wat-reference-v2/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"
AUDIT_PREFIX="${GROWTHSENT_AUDIT_PREFIX:-production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ -f "$REFERENCE_MANIFEST" ]] || { echo "Missing reviewed public-source semantic baseline v2: $REFERENCE_MANIFEST" >&2; exit 1; }
[[ "$AUDIT_PREFIX" =~ ^production/common-crawl/audit/public-source-baseline/v2/[a-z0-9][a-z0-9-]{0,63}/$ ]] || { echo "The audit prefix is not an isolated public-source-baseline v2 namespace." >&2; exit 1; }

PUBLISH_DIRECTORY="$(mktemp -d -t growthsent-cloudflare-public-baseline-publish-XXXXXX)"
cp "$SCRIPT_DIR/publish-public-baseline-v2-wsl.mjs" "$PUBLISH_DIRECTORY/publish-public-baseline-v2-wsl.mjs"
npm --prefix "$PUBLISH_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

echo "GrowthSent public-source baseline v2 publication (Ubuntu/WSL native)"
echo "Destination: $AUDIT_PREFIX"
echo "The destination must be empty. This publishes exactly one manifest and a completion marker written last."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
if [[ -z "$PARENT_TOKEN" ]]; then
  echo "A parent Cloudflare API token is required." >&2
  exit 1
fi

set +e
printf '%s' "$PARENT_TOKEN" | node "$PUBLISH_DIRECTORY/publish-public-baseline-v2-wsl.mjs" "$REFERENCE_MANIFEST"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Baseline publication did not complete. No retry was attempted." >&2
  exit "$RESULT"
fi
