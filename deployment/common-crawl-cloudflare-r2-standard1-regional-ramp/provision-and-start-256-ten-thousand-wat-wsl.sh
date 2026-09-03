#!/usr/bin/env bash
# Provision one guarded 256-slot 10,000-WAT regional run after its local gate passes.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-256-ten-thousand-wat-run" ]]; then
  echo "Usage: $0 --approved-256-ten-thousand-wat-run" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked 10,000-WAT base manifest: $SOURCE_MANIFEST" >&2; exit 1; }
NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-256-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-256-ten-thousand-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"
LANES=(apac-a apac-b enam-a enam-b wnam-a wnam-b weur-a weur-b)

echo "GrowthSent regional standard-1 256-slot 10,000-WAT run (Ubuntu/WSL native)"
echo "Run ID: $RUN_ID"
echo "Scope: 10,000 locked WATs, eight isolated regional Workers, and 32 fixed standard-1 Containers per Worker (256 total)."
echo "Safety: every fresh lane prefix is preflighted before deployment. Sibling lanes remain region-constrained and use 30-second lane spacing with an offset, avoiding a cold-start burst."
echo "Child R2 credentials last six days, are write-only and lane-prefix-scoped, and refuse starts inside their final three-hour window. The parent token stays local."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 10000 \
  --max-concurrent 32 \
  --start-spacing-seconds 30 \
  --execution-profile regional-256-ten-thousand-wat \
  --output-dir "$RUN_DIRECTORY"
for LANE in "${LANES[@]}"; do npm --prefix "$RUN_DIRECTORY/bundles/$LANE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"
mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-256-ten-thousand-wat-run "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "256-slot 10,000-WAT provisioner failed. Do not rerun it; an earlier regional lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free 256-slot 10,000-WAT run context: $RUN_DIRECTORY/HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json"
