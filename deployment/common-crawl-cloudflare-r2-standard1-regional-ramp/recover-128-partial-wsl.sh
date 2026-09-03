#!/usr/bin/env bash
# Recover only incomplete WATs from a stopped 128-slot checkpoint into fresh prefixes.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-128-partial-recovery" ]]; then
  echo "Usage: $0 --approved-128-partial-recovery" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_HIGH_CAPACITY_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00010-of-00100.json}"
SOURCE_CONTEXT="${GROWTHSENT_HIGH_CAPACITY_RECOVERY_SOURCE_CONTEXT:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_HIGH_CAPACITY_RECOVERY_SOURCE_CONTEXT to the stopped HIGH-CAPACITY-CHECKPOINT-CONTEXT.json." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked high-capacity source shard manifest: $SOURCE_MANIFEST" >&2; exit 1; }
[[ -f "$SOURCE_CONTEXT" ]] || { echo "Missing stopped high-capacity source context: $SOURCE_CONTEXT" >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-128rcvr-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-128-recovery-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"
RECOVERY_CONTRACT="$TEMP_ROOT/RECOVERY-CONTRACT.json"

echo "GrowthSent audited 128-slot partial recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: read-only inventory of the stopped 128-slot checkpoint, then exactly its incomplete WATs in fresh regional prefixes with up to 32 standard-1 slots per active region."
echo "Safety: existing R2 output is immutable and read-only; completed WATs are excluded by a hashed completion-marker inventory; no object is overwritten."
echo "Child credentials last six days, are write-only and prefix-scoped, and refuse starts inside their final three-hour window."
read -r -p "Press Enter to continue: " _

mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
cp "$SCRIPT_DIR/prepare-128-partial-recovery-wsl.mjs" "$CONTROLLER_DIRECTORY/prepare-128-partial-recovery-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }

set +e
printf '%s' "$PARENT_TOKEN" | node "$CONTROLLER_DIRECTORY/prepare-128-partial-recovery-wsl.mjs" "$SOURCE_CONTEXT" "$RECOVERY_CONTRACT"
RESULT=$?
set -e
if [[ $RESULT -ne 0 ]]; then
  unset PARENT_TOKEN
  echo "Read-only recovery inventory did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi

RECOVERY_TASK_COUNT="$(node -e 'const source=require(process.argv[1]); if (!Number.isInteger(source.recovery_task_count) || source.recovery_task_count < 0) process.exit(2); process.stdout.write(String(source.recovery_task_count));' "$RECOVERY_CONTRACT")"
if [[ "$RECOVERY_TASK_COUNT" == "0" ]]; then
  unset PARENT_TOKEN
  echo "SUCCESS: the stopped checkpoint already has a valid completion marker for every WAT. No Worker or Container was deployed."
  echo "Secret-free recovery inventory: $RECOVERY_CONTRACT"
  exit 0
fi

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count "$RECOVERY_TASK_COUNT" \
  --max-concurrent 32 \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$RUN_DIRECTORY"
for REGION in apac enam wnam weur; do npm --prefix "$RUN_DIRECTORY/bundles/$REGION" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-128-partial-recovery "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "128-slot partial recovery provisioner failed. Do not rerun it; a fresh regional lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free recovery context: $RUN_DIRECTORY/HIGH-CAPACITY-PARTIAL-RECOVERY-CONTEXT.json"
