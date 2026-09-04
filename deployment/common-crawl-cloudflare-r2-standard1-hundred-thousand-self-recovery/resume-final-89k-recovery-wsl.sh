#!/usr/bin/env bash
# Resume a locally prepared final-89K recovery plan without repeating its
# already completed read-only completion-marker inventory.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-final-89k-recovery-provision" ]]; then
  echo "Usage: $0 --approved-final-89k-recovery-provision" >&2
  exit 2
fi

PLAN="${GROWTHSENT_FINAL_89K_RECOVERY_PLAN:-}"
[[ -n "$PLAN" && -f "$PLAN" ]] || { echo "Set GROWTHSENT_FINAL_89K_RECOVERY_PLAN to the prepared FINAL-89K-RECOVERY-RUN-PLAN.json." >&2; exit 2; }

WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLAN="$(cd -- "$(dirname -- "$PLAN")" && pwd)/$(basename -- "$PLAN")"
RUN_DIRECTORY="$(dirname -- "$PLAN")"

# Fail locally before a token is requested if the plan and its immutable
# inventory contract do not still bind the same exact missing source set.
python3 - "$PLAN" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

plan_path = Path(sys.argv[1]).resolve()
plan = json.loads(plan_path.read_text(encoding="utf-8"))

def digest(document, field):
    payload = dict(document)
    claimed = payload.pop(field, None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if not isinstance(claimed, str) or claimed != hashlib.sha256(encoded).hexdigest():
        raise SystemExit(f"{field} is invalid")
    return claimed

if plan.get("kind") != "growthsent-cloudflare-r2-standard1-final-89k-recovery-plan-v1" or plan.get("execution_profile") != "regional-1440-final-eighty-nine-thousand-recovery":
    raise SystemExit("The supplied plan is not a final-89K recovery plan")
digest(plan, "plan_sha256")
run_id = plan.get("run_id")
if not isinstance(run_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
    raise SystemExit("The recovery run ID is invalid")
task_count = (plan.get("processing_window") or {}).get("task_count")
lanes = plan.get("lanes")
recovery = plan.get("recovery") or {}
if not isinstance(task_count, int) or task_count < 1 or task_count > 89_000 or not isinstance(lanes, list) or not 1 <= len(lanes) <= 45:
    raise SystemExit("The recovery task or lane count is invalid")
if plan.get("r2_root") != f"production/common-crawl/cloudflare-r2-final-recoveries/v1/{run_id}/":
    raise SystemExit("The recovery R2 root is invalid")
contract_path = Path(recovery.get("contract_path", ""))
if not contract_path.is_file():
    raise SystemExit("The immutable recovery contract is unavailable")
contract = json.loads(contract_path.read_text(encoding="utf-8"))
if contract.get("kind") != "growthsent-cloudflare-r2-standard1-final-89k-recovery-contract-v1":
    raise SystemExit("The immutable recovery contract identity is invalid")
contract_digest = digest(contract, "contract_sha256")
if recovery.get("contract_sha256") != contract_digest:
    raise SystemExit("The plan is not bound to its immutable recovery contract")
indexes = recovery.get("recovery_source_indexes")
if not isinstance(indexes, list) or indexes != contract.get("recovery_source_indexes") or len(indexes) != task_count or indexes != sorted(set(indexes)):
    raise SystemExit("The recovery source identities differ from the immutable contract")
if sum(item.get("regional_task_count", -1) for item in lanes if isinstance(item, dict)) != task_count:
    raise SystemExit("The recovery lane partition is incomplete")
groups = {}
for index, lane in enumerate(lanes):
    if not isinstance(lane, dict) or lane.get("lane_index") != index or lane.get("lane_count") != len(lanes) or not isinstance(lane.get("bundle"), str) or not Path(lane["bundle"]).is_dir():
        raise SystemExit("A reviewed recovery lane bundle is unavailable")
    group = lane.get("placement_group")
    groups[group] = groups.get(group, 0) + 1
if groups != (plan.get("topology") or {}).get("placement_group_lane_counts"):
    raise SystemExit("The recovery placement-group allocation is invalid")
if (plan.get("topology") or {}).get("max_concurrent_total") != sum(item.get("max_concurrent", -1) for item in lanes):
    raise SystemExit("The recovery concurrency allocation is invalid")
PY

ADMISSION_BUNDLE="$RUN_DIRECTORY/admission"
[[ -f "$ADMISSION_BUNDLE/wrangler.jsonc" ]] || { echo "The prepared recovery plan is missing its admission bundle." >&2; exit 1; }
mapfile -t LANE_BUNDLES < <(python3 - "$PLAN" <<'PY'
import json
import sys
from pathlib import Path
for lane in json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["lanes"]:
    print(lane["bundle"])
PY
)

echo "GrowthSent prepared final 89K recovery provision (Ubuntu/WSL native)"
echo "Plan: $PLAN"
echo "Scope: only the immutable contract's $(( ${#LANE_BUNDLES[@]} )) recovery lane(s) and their missing WAT source identities. The completed original 89K R2 root is read-only."
echo "This resumes after a pre-deployment local validation failure; it does not repeat the 89K completion-marker inventory."
read -r -p "Press Enter to continue: " _

npm --prefix "$ADMISSION_BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
for bundle in "${LANE_BUNDLES[@]}"; do npm --prefix "$bundle" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null; done
BOTO3_SITE_PACKAGES="$RUN_DIRECTORY/.boto3-preflight-packages"
if ! PYTHONPATH="$BOTO3_SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import boto3; assert boto3.__version__ == "1.43.67"' >/dev/null 2>&1; then
  python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --upgrade --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"
fi

# Compile one representative Worker/Container before any Cloudflare mutation.
REPRESENTATIVE_BUNDLE="${LANE_BUNDLES[0]}"
(
  cd -- "$REPRESENTATIVE_BUNDLE"
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config wrangler.jsonc >/dev/null
)

CONTROLLER_DIRECTORY="$RUN_DIRECTORY/final-recovery-resume-controller"
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
  echo "Final 89K recovery provisioner failed. Inspect its safe JSON output before any retry; it may already have deployed or scheduled a fresh recovery lane." >&2
  exit "$RESULT"
fi
echo "SUCCESS: the final 89K recovery schedules were accepted. The remote Containers continue without this terminal."
echo "Secret-free recovery context: $RUN_DIRECTORY/FINAL-89K-RECOVERY-RUN-CONTEXT.json"
