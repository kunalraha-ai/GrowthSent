#!/usr/bin/env bash
# Resume exactly one SIGTERM-interrupted final-89K lane in place.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-final-89k-lane-resume" ]]; then
  echo "Usage: $0 --approved-final-89k-lane-resume" >&2
  exit 2
fi

CONTEXT="${GROWTHSENT_FINAL_89K_CONTEXT:-}"
LANE="${GROWTHSENT_FINAL_89K_RESUME_LANE:-}"
[[ -n "$CONTEXT" && -f "$CONTEXT" ]] || { echo "Set GROWTHSENT_FINAL_89K_CONTEXT to FINAL-89K-RUN-CONTEXT.json." >&2; exit 2; }
[[ "$LANE" =~ ^(APAC|ENAM|WNAM|EEUR|WEUR|SAM)-[0-9]{2}$ ]] || { echo "Set GROWTHSENT_FINAL_89K_RESUME_LANE to one explicit final lane, such as ENAM-05." >&2; exit 2; }

WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 curl mktemp; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PLAN="$(dirname -- "$CONTEXT")/SELF-RECOVERY-RUN-PLAN.json"
[[ -f "$PLAN" ]] || { echo "The final context does not have its reviewed SELF-RECOVERY-RUN-PLAN.json beside it." >&2; exit 1; }

mapfile -t LANE_DETAILS < <(python3 - "$CONTEXT" "$PLAN" "$LANE" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

context_path, plan_path, expected_lane = map(Path, sys.argv[1:])
expected_lane = str(expected_lane)
context = json.loads(context_path.read_text(encoding="utf-8"))
plan = json.loads(plan_path.read_text(encoding="utf-8"))
payload = dict(plan)
digest = payload.pop("plan_sha256", None)
canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
if plan.get("kind") != "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-plan-v1" or digest != hashlib.sha256(canonical).hexdigest():
    raise SystemExit("The final 89K plan identity or digest is invalid.")
if context.get("run_id") != plan.get("run_id") or context.get("task_count") != 89000:
    raise SystemExit("The supplied final context is not bound to the reviewed 89K plan.")
context_lanes = {item.get("lane"): item for item in context.get("lanes", []) if isinstance(item, dict)}
plan_lanes = {item.get("lane"): item for item in plan.get("lanes", []) if isinstance(item, dict)}
item = plan_lanes.get(expected_lane)
observed = context_lanes.get(expected_lane)
if not isinstance(item, dict) or not isinstance(observed, dict):
    raise SystemExit("The requested lane is absent from the reviewed final plan or run context.")
required = ("bundle", "worker_name", "placement_group", "regional_task_count")
if any(not isinstance(item.get(key), (str, int)) for key in required):
    raise SystemExit("The requested lane plan is malformed.")
if observed.get("worker_name") != item["worker_name"] or observed.get("lane") != expected_lane or not isinstance(observed.get("worker_url"), str) or not isinstance(observed.get("prefix"), str):
    raise SystemExit("The requested lane context does not match the reviewed plan.")
if item.get("max_concurrent") != 32 or item.get("max_instances") != 32 or item.get("lane_count") != 45:
    raise SystemExit("The requested lane is not an immutable 32-slot final-campaign lane.")
print(item["bundle"])
print(item["worker_name"])
print(observed["worker_url"])
print(observed["prefix"])
print(plan["run_id"])
print(item["placement_group"])
print(item["regional_task_count"])
PY
)
[[ ${#LANE_DETAILS[@]} -eq 7 ]] || { echo "Could not load one safe final-lane repair target." >&2; exit 1; }
BUNDLE="${LANE_DETAILS[0]}"
WORKER="${LANE_DETAILS[1]}"
WORKER_URL="${LANE_DETAILS[2]}"
PREFIX="${LANE_DETAILS[3]}"
RUN_ID="${LANE_DETAILS[4]}"
PLACEMENT_GROUP="${LANE_DETAILS[5]}"
TASK_COUNT="${LANE_DETAILS[6]}"
[[ -f "$BUNDLE/wrangler.jsonc" && -f "$BUNDLE/src/index.ts" ]] || { echo "The reviewed source lane bundle is unavailable: $BUNDLE" >&2; exit 1; }

echo "GrowthSent final 89K single-lane SIGTERM resume (Ubuntu/WSL native)"
echo "Lane: $LANE ($WORKER)"
echo "Scope: deploy only this terminal lane's coordinator repair, retain its existing R2 prefix, and either retry a SIGTERM-interrupted task or quarantine an immutable partial task while the remaining queue continues. No healthy lane Worker, Container, or R2 prefix is contacted."
read -r -p "Press Enter to continue: " _

STATUS_JSON="$(curl --fail-with-body --silent --show-error --max-time 30 "$WORKER_URL/_growthsent_standard1_regional_ramp/status")" || { echo "The selected lane status endpoint was unavailable; no deployment was made." >&2; exit 1; }
python3 - "$RUN_ID" "$LANE" "$STATUS_JSON" <<'PY'
import json
import sys

run_id, lane, document = sys.argv[1:]
status = json.loads(document)
failure = ((status.get("launch") or {}).get("terminal_failure") or {}).get("failure") or {}
if status.get("run_id") != run_id or status.get("region") != lane or status.get("control_secret_configured") is not True:
    raise SystemExit("The selected Worker status is not bound to the reviewed final lane.")
if (status.get("launch") or {}).get("state") != "task_failed":
    raise SystemExit("The selected lane is not terminally failed; refusing to touch it.")
if failure.get("type") != "TaskProcessExit":
    raise SystemExit("The selected lane did not fail with a reviewed task-process condition; use an isolated recovery plan instead.")
PY
REPAIR_ENDPOINT="$(python3 - "$RUN_ID" "$LANE" "$STATUS_JSON" <<'PY'
import json
import sys

run_id, lane, document = sys.argv[1:]
status = json.loads(document)
failure = ((status.get("launch") or {}).get("terminal_failure") or {}).get("failure") or {}
message = str(failure.get("message"))
if status.get("run_id") != run_id or status.get("region") != lane or status.get("control_secret_configured") is not True or (status.get("launch") or {}).get("state") != "task_failed" or failure.get("type") != "TaskProcessExit":
    raise SystemExit("The selected lane state changed during repair preparation; refusing to touch it.")
if "task process exited with code -15" in message:
    print("resume-interrupted-task")
elif "partial immutable task prefix requires isolated recovery" in message or "destination conflict:" in message:
    print("resume-quarantined-partial-task")
else:
    raise SystemExit("The selected failure is not safe for this in-place repair.")
PY
)"

REPAIR_ROOT="$(mktemp -d /tmp/growthsent-final-89k-lane-resume-XXXXXX)"
cleanup() { rm -rf -- "$REPAIR_ROOT"; }
trap cleanup EXIT
REPAIR_BUNDLE="$REPAIR_ROOT/bundle"
cp -a "$BUNDLE" "$REPAIR_BUNDLE"
cp "$ROOT/deployment/common-crawl-cloudflare-r2-standard1-regional-ramp/src/index.ts" "$REPAIR_BUNDLE/src/index.ts"

python3 - "$REPAIR_BUNDLE/wrangler.jsonc" "$WORKER" "$RUN_ID" "$LANE" "$PLACEMENT_GROUP" "$PREFIX" "$TASK_COUNT" <<'PY'
import json
import sys
from pathlib import Path

path, worker, run_id, lane, placement, prefix, task_count = sys.argv[1:]
config = json.loads(Path(path).read_text(encoding="utf-8"))
container = (config.get("containers") or [None])[0]
vars = config.get("vars") or {}
if config.get("name") != worker or vars.get("GROWTHSENT_RAMP_ID") != run_id or vars.get("GROWTHSENT_REGION") != lane or vars.get("GROWTHSENT_PLACEMENT_GROUP") != placement or vars.get("GROWTHSENT_R2_OUTPUT_PREFIX") != prefix.rstrip("/") or vars.get("GROWTHSENT_REGIONAL_TASK_COUNT") != task_count or not isinstance(container, dict) or container.get("instance_type") != "standard-1" or container.get("max_instances") != 32:
    raise SystemExit("The copied repair bundle differs from the reviewed single-lane configuration.")
PY

npm --prefix "$REPAIR_BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$REPAIR_BUNDLE/wrangler.jsonc"
npx --offline --yes wrangler@4.126.0 deploy --config "$REPAIR_BUNDLE/wrangler.jsonc"

TRIGGER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf '%s' "$TRIGGER_TOKEN" | npx --offline --yes wrangler@4.126.0 secret put RAMP_TRIGGER_TOKEN --name "$WORKER" --config "$REPAIR_BUNDLE/wrangler.jsonc" >/dev/null

RESULT_FILE="$REPAIR_ROOT/resume-response.json"
RESULT=""
for attempt in $(seq 1 15); do
  if ! STATUS_CODE="$(curl --silent --show-error --max-time 30 --request POST --header 'Content-Type: application/octet-stream' --data-binary "$TRIGGER_TOKEN" --output "$RESULT_FILE" --write-out '%{http_code}' "$WORKER_URL/_growthsent_standard1_regional_ramp/$REPAIR_ENDPOINT")"; then
    echo "The updated terminal lane resume request could not reach Cloudflare; no other lane was changed." >&2
    exit 1
  fi
  if [[ "$STATUS_CODE" == "202" ]]; then
    RESULT="$(<"$RESULT_FILE")"
    break
  fi
  # A newly written secret can take a few seconds to become visible at the
  # Worker edge.  Only retry its deliberately opaque unauthorised response.
  if [[ "$STATUS_CODE" != "404" || $attempt -eq 15 ]]; then
    echo "The updated terminal lane did not accept its resume request (HTTP $STATUS_CODE): $(<"$RESULT_FILE")" >&2
    exit 1
  fi
  sleep 2
done
unset TRIGGER_TOKEN
python3 - "$RUN_ID" "$LANE" "$RESULT" "$REPAIR_ROOT/FINAL-89K-LANE-RESUME-CONTEXT.json" <<'PY'
import json
import sys
from pathlib import Path

run_id, lane, document, output = sys.argv[1:]
result = json.loads(document)
if result.get("accepted") is not True or result.get("run_id") != run_id or result.get("region") != lane or not isinstance(result.get("task_index"), int):
    raise SystemExit("The selected lane declined the targeted interrupted-task resume.")
Path(output).write_text(json.dumps({"run_id": run_id, "lane": lane, "resumed_task_index": result["task_index"], "resumed_local_task_number": result.get("local_task_number")}, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "SUCCESS: only $LANE was patched and its interrupted task was returned to its existing 32-slot queue. Existing immutable completion markers remain authoritative."
