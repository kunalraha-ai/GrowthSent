#!/usr/bin/env bash
# Recover only WATs missing a completion marker from a stopped 256-slot run.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-256-partial-recovery" ]]; then
  echo "Usage: $0 --approved-256-partial-recovery" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json}"
SOURCE_CONTEXT="${GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_RECOVERY_SOURCE_CONTEXT:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_RECOVERY_SOURCE_CONTEXT to the stopped HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked 10,000-WAT source manifest: $SOURCE_MANIFEST" >&2; exit 1; }
[[ -f "$SOURCE_CONTEXT" ]] || { echo "Missing stopped 256-slot source context: $SOURCE_CONTEXT" >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-256rcvr-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-256-recovery-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"
RECOVERY_CONTRACT="$TEMP_ROOT/RECOVERY-CONTRACT.json"

echo "GrowthSent audited 256-slot 10,000-WAT partial recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: first prove all eight source lanes are inactive, then run exactly the WATs without a valid immutable completion marker in fresh lane prefixes."
echo "Safety: source R2 output is read-only; every recovered task is selected by a hashed completion-marker inventory; no object is overwritten."
echo "Each active recovery lane has at most 32 standard-1 slots; child credentials are write-only, lane-prefix-scoped, and expire after six days."
read -r -p "Press Enter to continue: " _

mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
cp "$SCRIPT_DIR/prepare-128-partial-recovery-wsl.mjs" "$CONTROLLER_DIRECTORY/prepare-high-capacity-partial-recovery-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }

set +e
printf '%s' "$PARENT_TOKEN" | node "$CONTROLLER_DIRECTORY/prepare-high-capacity-partial-recovery-wsl.mjs" "$SOURCE_CONTEXT" "$RECOVERY_CONTRACT"
RESULT=$?
set -e
if [[ $RESULT -ne 0 ]]; then
  unset PARENT_TOKEN
  echo "Read-only 256-slot recovery inventory did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi

RECOVERY_TASK_COUNT="$(node -e 'const source=require(process.argv[1]); if (!Number.isInteger(source.recovery_task_count) || source.recovery_task_count < 0) process.exit(2); process.stdout.write(String(source.recovery_task_count));' "$RECOVERY_CONTRACT")"
if [[ "$RECOVERY_TASK_COUNT" == "0" ]]; then
  unset PARENT_TOKEN
  echo "SUCCESS: every source WAT already has a valid completion marker. No Worker or Container was deployed."
  echo "Secret-free recovery inventory: $RECOVERY_CONTRACT"
  exit 0
fi

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count "$RECOVERY_TASK_COUNT" \
  --max-concurrent 32 \
  --start-spacing-seconds 30 \
  --execution-profile regional-256-ten-thousand-wat \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$RUN_DIRECTORY"
for BUNDLE in "$RUN_DIRECTORY"/bundles/*; do npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-256-partial-recovery "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "256-slot partial recovery provisioner failed. Do not rerun it; a fresh recovery lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free recovery context: $RUN_DIRECTORY/HIGH-CAPACITY-TEN-THOUSAND-PARTIAL-RECOVERY-CONTEXT.json"
