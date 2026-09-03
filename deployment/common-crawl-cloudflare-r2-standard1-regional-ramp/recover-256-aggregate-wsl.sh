#!/usr/bin/env bash
# Recover only globally missing source WATs after all 256-slot 10K lanes stop.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-256-aggregate-recovery" ]]; then
  echo "Usage: $0 --approved-256-aggregate-recovery" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json}"
SOURCE_CONTEXT="${GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_RECOVERY_SOURCE_CONTEXT:-}"
SUPPLEMENTAL_CONTEXTS="${GROWTHSENT_AGGREGATE_COMPLETION_CONTEXTS:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_HIGH_CAPACITY_TEN_THOUSAND_RECOVERY_SOURCE_CONTEXT to the original HIGH-CAPACITY-TEN-THOUSAND-RAMP-CONTEXT.json." >&2; exit 2; }
[[ -n "$SUPPLEMENTAL_CONTEXTS" ]] || { echo "Set GROWTHSENT_AGGREGATE_COMPLETION_CONTEXTS to pipe-separated terminal recovery context paths." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" && -f "$SOURCE_CONTEXT" ]] || { echo "The locked manifest or original 256-slot context is missing." >&2; exit 1; }
IFS='|' read -r -a COMPLETION_CONTEXTS <<< "$SUPPLEMENTAL_CONTEXTS"
[[ ${#COMPLETION_CONTEXTS[@]} -ge 1 && ${#COMPLETION_CONTEXTS[@]} -le 8 ]] || { echo "GROWTHSENT_AGGREGATE_COMPLETION_CONTEXTS must contain one to eight pipe-separated paths." >&2; exit 2; }
for context in "${COMPLETION_CONTEXTS[@]}"; do [[ -f "$context" ]] || { echo "Missing supplemental recovery context: $context" >&2; exit 1; }; done

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-256merge-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-256-aggregate-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"
RECOVERY_CONTRACT="$TEMP_ROOT/AGGREGATE-RECOVERY-CONTRACT.json"

echo "GrowthSent audited aggregate 256-slot 10,000-WAT recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: read-only completion-marker inventory across the original 10,000-WAT root and terminal recovery roots, then only globally missing WATs in fresh prefixes."
echo "Safety: all supplied Workers must be inactive; every existing R2 root is read-only; source identity, not local task counters, determines recovery membership."
read -r -p "Press Enter to continue: " _

mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-and-start-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs"
cp "$SCRIPT_DIR/prepare-aggregate-256-recovery-wsl.mjs" "$CONTROLLER_DIRECTORY/prepare-aggregate-256-recovery-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | node "$CONTROLLER_DIRECTORY/prepare-aggregate-256-recovery-wsl.mjs" "$SOURCE_CONTEXT" "$SUPPLEMENTAL_CONTEXTS" "$RECOVERY_CONTRACT"
RESULT=$?
set -e
if [[ $RESULT -ne 0 ]]; then
  unset PARENT_TOKEN
  echo "Read-only aggregate recovery inventory did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi

RECOVERY_TASK_COUNT="$(node -e 'const source=require(process.argv[1]); if (!Number.isInteger(source.recovery_task_count) || source.recovery_task_count < 0) process.exit(2); process.stdout.write(String(source.recovery_task_count));' "$RECOVERY_CONTRACT")"
if [[ "$RECOVERY_TASK_COUNT" == "0" ]]; then
  unset PARENT_TOKEN
  echo "SUCCESS: every locked WAT has a valid immutable completion marker. No Worker or Container was deployed."
  echo "Secret-free aggregate inventory: $RECOVERY_CONTRACT"
  exit 0
fi

python3 "$SCRIPT_DIR/build_bundles.py" --run-id "$RUN_ID" --source-manifest "$SOURCE_MANIFEST" --task-count "$RECOVERY_TASK_COUNT" --max-concurrent 32 --start-spacing-seconds 30 --execution-profile regional-256-ten-thousand-wat --recovery-contract "$RECOVERY_CONTRACT" --source-run-context "$SOURCE_CONTEXT" --output-dir "$RUN_DIRECTORY"
for BUNDLE in "$RUN_DIRECTORY"/bundles/*; do npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-and-start-wsl.mjs" --approved-256-failed-lane-recovery "$RUN_DIRECTORY/RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Aggregate recovery provisioner failed. Do not rerun it; a fresh recovery lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free aggregate recovery context: $RUN_DIRECTORY/HIGH-CAPACITY-TEN-THOUSAND-FAILED-LANE-RECOVERY-CONTEXT.json"
