#!/usr/bin/env bash
# Start only the exact 18 incomplete WATs from the diagnosed ENAM 100-WAT lane.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-enam-recovery" ]]; then
  echo "Usage: $0 --approved-enam-recovery" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00000-of-00100.json}"
SOURCE_CONTEXT="${GROWTHSENT_ENAM_RECOVERY_SOURCE_CONTEXT:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_ENAM_RECOVERY_SOURCE_CONTEXT to the original 100-WAT REGIONAL-RAMP-CONTEXT.json." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RECOVERY_CONTRACT="$SCRIPT_DIR/enam-recovery-source-v1.json"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked source shard manifest: $SOURCE_MANIFEST" >&2; exit 1; }
[[ -f "$RECOVERY_CONTRACT" ]] || { echo "Missing reviewed ENAM recovery contract: $RECOVERY_CONTRACT" >&2; exit 1; }
[[ -f "$SOURCE_CONTEXT" ]] || { echo "Missing original source-run context: $SOURCE_CONTEXT" >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-enam-recover-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-enam-recovery-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"

echo "GrowthSent isolated ENAM standard-1 recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: exactly 18 diagnosed incomplete ENAM WATs; one fresh ENAM Worker; four active standard-1 Containers; 15-second spacing."
echo "Safety: the original 100-WAT run and all 82 completed task prefixes are read-only to this recovery. A fresh R2 prefix is preflighted before deployment."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 18 \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$RUN_DIRECTORY"
npm --prefix "$RUN_DIRECTORY/bundles/enam" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"
mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-enam-recovery "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "ENAM recovery provisioner failed. Do not rerun it; inspect the safe output because the fresh lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free recovery context: $RUN_DIRECTORY/ENAM-RECOVERY-CONTEXT.json"
