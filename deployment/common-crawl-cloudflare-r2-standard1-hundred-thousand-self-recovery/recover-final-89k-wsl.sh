#!/usr/bin/env bash
# Inventory terminal final-89K output and recover only source identities that
# lack a valid immutable TASK-COMPLETED marker.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-final-89k-recovery" ]]; then
  echo "Usage: $0 --approved-final-89k-recovery" >&2
  exit 2
fi

SOURCE_CONTEXT="${GROWTHSENT_FINAL_89K_RECOVERY_SOURCE_CONTEXT:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -n "$SOURCE_CONTEXT" && -f "$SOURCE_CONTEXT" ]] || { echo "Set GROWTHSENT_FINAL_89K_RECOVERY_SOURCE_CONTEXT to the terminal FINAL-89K-RUN-CONTEXT.json." >&2; exit 2; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
SOURCE_MANIFEST="$(node -e 'const fs=require("fs"); const path=require("path"); const context=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const plan=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "SELF-RECOVERY-RUN-PLAN.json"), "utf8")); if (context.run_id!==plan.run_id || typeof plan?.source_manifest?.path!=="string") process.exit(2); process.stdout.write(plan.source_manifest.path);' "$SOURCE_CONTEXT")"
[[ -f "$SOURCE_MANIFEST" ]] || { echo "The locked 100K source manifest referenced by the final context is unavailable." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-89rcvr-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-final-89k-recovery-${RUN_ID}-XXXXXX")"
RUN_DIRECTORY="$TEMP_ROOT/bundle"
CONTROLLER_DIRECTORY="$TEMP_ROOT/controller"
RECOVERY_CONTRACT="$TEMP_ROOT/FINAL-89K-RECOVERY-CONTRACT.json"

echo "GrowthSent audited final 89K recovery (Ubuntu/WSL native)"
echo "Recovery run ID: $RUN_ID"
echo "Scope: read-only immutable completion-marker inventory across the stopped final 89K campaign, then only missing source identities in fresh recovery prefixes."
echo "Safety: every source lane must already be terminal; original R2 output is read-only and every recovery credential is write-only and lane-prefix-scoped."
read -r -p "Press Enter to continue: " _

mkdir "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/prepare-final-89k-recovery-wsl.mjs" "$CONTROLLER_DIRECTORY/prepare-final-89k-recovery-wsl.mjs"
cp "$SCRIPT_DIR/provision-final-89k-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-final-89k-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | node "$CONTROLLER_DIRECTORY/prepare-final-89k-recovery-wsl.mjs" "$SOURCE_CONTEXT" "$RECOVERY_CONTRACT"
RESULT=$?
set -e
if [[ $RESULT -ne 0 ]]; then
  unset PARENT_TOKEN
  echo "Read-only final 89K recovery inventory did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi

RECOVERY_TASK_COUNT="$(node -e 'const c=require(process.argv[1]); if (!Number.isInteger(c.recovery_task_count) || c.recovery_task_count < 0) process.exit(2); process.stdout.write(String(c.recovery_task_count));' "$RECOVERY_CONTRACT")"
if [[ "$RECOVERY_TASK_COUNT" == "0" ]]; then
  unset PARENT_TOKEN
  echo "SUCCESS: every final 89K source identity has a valid immutable completion marker. No Worker or Container was deployed."
  echo "Secret-free recovery inventory: $RECOVERY_CONTRACT"
  exit 0
fi

python3 "$SCRIPT_DIR/build_final_89k_recovery_bundles.py" --run-id "$RUN_ID" --source-manifest "$SOURCE_MANIFEST" --recovery-contract "$RECOVERY_CONTRACT" --output-dir "$RUN_DIRECTORY"
for BUNDLE in "$RUN_DIRECTORY"/admission "$RUN_DIRECTORY"/lanes/*; do npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

# Compile one complete Worker/Container bundle before any Cloudflare mutation.
REPRESENTATIVE_BUNDLE="$(find "$RUN_DIRECTORY/lanes" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$REPRESENTATIVE_BUNDLE" ]] || { echo "No recovery lane bundle was created." >&2; exit 1; }
(
  cd -- "$REPRESENTATIVE_BUNDLE"
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config wrangler.jsonc >/dev/null
)

set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-final-89k-wsl.mjs" --approved-final-89k-run "$RUN_DIRECTORY/FINAL-89K-RECOVERY-RUN-PLAN.json"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Final 89K recovery provisioner failed. Do not rerun it; a fresh recovery lane may already be running." >&2
  exit "$RESULT"
fi
echo "Secret-free recovery contract: $RECOVERY_CONTRACT"
echo "Secret-free recovery context: $RUN_DIRECTORY/FINAL-89K-RECOVERY-RUN-CONTEXT.json"
