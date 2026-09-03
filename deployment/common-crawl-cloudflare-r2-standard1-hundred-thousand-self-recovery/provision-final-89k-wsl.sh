#!/usr/bin/env bash
# Provision the final remaining-89K campaign only after the local gate.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-final-89k-run" ]]; then
  echo "Usage: $0 --approved-final-89k-run" >&2
  exit 2
fi

PLAN="${GROWTHSENT_FINAL_89K_PLAN:-}"
[[ -n "$PLAN" ]] || { echo "Set GROWTHSENT_FINAL_89K_PLAN to SELF-RECOVERY-RUN-PLAN.json from the passing final local gate." >&2; exit 2; }
[[ -f "$PLAN" ]] || { echo "Missing final 89K local plan: $PLAN" >&2; exit 1; }

WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLAN="$(cd -- "$(dirname -- "$PLAN")" && pwd)/$(basename -- "$PLAN")"
RUN_DIRECTORY="$(dirname -- "$PLAN")"
ADMISSION_BUNDLE="$RUN_DIRECTORY/admission"
[[ -f "$ADMISSION_BUNDLE/wrangler.jsonc" ]] || { echo "The final plan is missing its admission bundle." >&2; exit 1; }

mapfile -t LANE_BUNDLES < <(python3 - "$PLAN" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for lane in plan.get("lanes", []):
    bundle = lane.get("bundle")
    if isinstance(bundle, str):
        print(bundle)
PY
)
[[ ${#LANE_BUNDLES[@]} -eq 45 ]] || { echo "The final plan does not contain exactly 45 lane bundles." >&2; exit 1; }
for bundle in "${LANE_BUNDLES[@]}"; do [[ -f "$bundle/wrangler.jsonc" ]] || { echo "Missing lane bundle: $bundle" >&2; exit 1; }; done

echo "GrowthSent final remaining 89,000-WAT launch (Ubuntu/WSL native)"
echo "Plan: $PLAN"
echo "Scope: 89,000 globally disjoint WATs (source indexes 11,000–99,999), 45 lane Workers, up to 1,440 standard-1 Containers, paced shared regional admission, and immutable R2 outputs."
echo "Safety: every fresh lane prefix is preflighted before an admission or lane Worker is deployed; the parent token remains local and only six-day lane-scoped child credentials are installed remotely."
echo "Published Cloudflare account limits cover this 1,440 standard-1 topology; regional admission and fresh-prefix preflights remain enforced."
read -r -p "Press Enter to continue: " _

npm --prefix "$ADMISSION_BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
for bundle in "${LANE_BUNDLES[@]}"; do npm --prefix "$bundle" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
if ! PYTHONPATH="$BOTO3_SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import boto3; assert boto3.__version__ == "1.43.67"' >/dev/null 2>&1; then
  python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --upgrade --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"
fi
CONTROLLER_DIRECTORY="$RUN_DIRECTORY/final-launch-controller"
mkdir -p "$CONTROLLER_DIRECTORY"
cp "$SCRIPT_DIR/provision-final-89k-wsl.mjs" "$CONTROLLER_DIRECTORY/provision-final-89k-wsl.mjs"
npm --prefix "$CONTROLLER_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$CONTROLLER_DIRECTORY/provision-final-89k-wsl.mjs" --approved-final-89k-run "$PLAN"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Final 89K provisioner failed. Inspect the safe JSON output: rerun only if it explicitly confirms that no Container start request was sent; otherwise create a recovery plan because an earlier lane may be running." >&2
  exit "$RESULT"
fi
echo "SUCCESS: final 89K schedules were accepted. The remote Containers continue without this terminal."
echo "Secret-free context: $RUN_DIRECTORY/FINAL-89K-RUN-CONTEXT.json"
