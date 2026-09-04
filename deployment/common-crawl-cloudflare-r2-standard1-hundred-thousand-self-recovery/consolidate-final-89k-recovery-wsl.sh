#!/usr/bin/env bash
# Build and provision exactly the missing final-89K identities through the
# existing, never-started APAC-01 recovery Worker reservation.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-final-89k-capacity-neutral-recovery" ]]; then
  echo "Usage: $0 --approved-final-89k-capacity-neutral-recovery" >&2
  exit 2
fi

SOURCE_PLAN="${GROWTHSENT_FINAL_89K_RECOVERY_PLAN:-}"
[[ -n "$SOURCE_PLAN" && -f "$SOURCE_PLAN" ]] || { echo "Set GROWTHSENT_FINAL_89K_RECOVERY_PLAN to the prepared 32-task FINAL-89K-RECOVERY-RUN-PLAN.json." >&2; exit 2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PLAN="$(cd -- "$(dirname -- "$SOURCE_PLAN")" && pwd)/$(basename -- "$SOURCE_PLAN")"
RUN_ID="$(python3 - "$SOURCE_PLAN" <<'PY'
import json
import sys
from pathlib import Path
plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if plan.get("kind") != "growthsent-cloudflare-r2-standard1-final-89k-recovery-plan-v1" or not isinstance(plan.get("run_id"), str):
    raise SystemExit("The supplied prepared recovery plan identity is invalid")
print(plan["run_id"])
PY
)"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-final-89k-consolidated-${RUN_ID}-XXXXXX")"
PLAN_DIRECTORY="$TEMP_ROOT/bundle"

echo "GrowthSent capacity-neutral final 89K recovery (Ubuntu/WSL native)"
echo "Source recovery plan: $SOURCE_PLAN"
echo "Scope: exactly the immutable contract's remaining source identities, consolidated into APAC-01's already-reserved 32 standard-1 slots."
echo "No original final-campaign Worker, completed R2 object, or active Container is stopped or changed. APAC-02/03 remain untouched."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_final_89k_consolidated_recovery.py" --source-plan "$SOURCE_PLAN" --output-dir "$PLAN_DIRECTORY"
GROWTHSENT_FINAL_89K_RECOVERY_PLAN="$PLAN_DIRECTORY/FINAL-89K-RECOVERY-RUN-PLAN.json" \
  bash "$SCRIPT_DIR/resume-final-89k-recovery-wsl.sh" --approved-final-89k-recovery-provision

echo "Secret-free consolidated recovery plan: $PLAN_DIRECTORY/FINAL-89K-RECOVERY-RUN-PLAN.json"
