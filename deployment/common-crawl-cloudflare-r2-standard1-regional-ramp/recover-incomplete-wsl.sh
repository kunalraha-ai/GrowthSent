#!/usr/bin/env bash
# Start only the audited incomplete WATs from the diagnosed 1,000-WAT run.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-incomplete-recovery" ]]; then
  echo "Usage: $0 --approved-incomplete-recovery" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00000-of-00100.json}"
SOURCE_CONTEXT="${GROWTHSENT_INCOMPLETE_RECOVERY_SOURCE_CONTEXT:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_INCOMPLETE_RECOVERY_SOURCE_CONTEXT to the original 1,000-WAT REGIONAL-RAMP-CONTEXT.json." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RECOVERY_CONTRACT="$SCRIPT_DIR/incomplete-1000-recovery-source-v1.json"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked source shard manifest: $SOURCE_MANIFEST" >&2; exit 1; }
[[ -f "$RECOVERY_CONTRACT" ]] || { echo "Missing reviewed incomplete recovery contract: $RECOVERY_CONTRACT" >&2; exit 1; }
[[ -f "$SOURCE_CONTEXT" ]] || { echo "Missing original source-run context: $SOURCE_CONTEXT" >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
# Keep the externally visible run identifier within Cloudflare's 64-character
# slug limit. The nonce still makes the fresh R2 root and four Worker names
# unique; the detailed recovery purpose is recorded in the immutable plan.
RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-incomplete-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-incomplete-recovery-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"

echo "GrowthSent audited incomplete 1,000-WAT recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: exactly 408 WATs absent from the original completion-marker inventory; four fresh regional Workers; four active standard-1 Containers per region."
echo "Safety: the original 1,000-WAT R2 root and all 592 completed task prefixes are read-only to this recovery. Every fresh regional prefix is preflighted before any Worker deployment."
echo "Child credentials last six days, are write-only and prefix-scoped, and refuse starts inside their final three-hour window."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 408 \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$RUN_DIRECTORY"
for REGION in apac enam wnam weur; do npm --prefix "$RUN_DIRECTORY/bundles/$REGION" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"
mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-incomplete-recovery "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Incomplete recovery provisioner failed. Do not rerun it; a fresh regional lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free recovery context: $RUN_DIRECTORY/INCOMPLETE-RECOVERY-CONTEXT.json"
