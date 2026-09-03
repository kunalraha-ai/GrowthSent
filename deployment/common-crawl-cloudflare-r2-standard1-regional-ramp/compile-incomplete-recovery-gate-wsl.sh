#!/usr/bin/env bash
# Local-only compilation gate for the audited incomplete 1,000-WAT recovery.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--source-context" || ! -f "$2" ]]; then
  echo "Usage: $0 --source-context <original-REGIONAL-RAMP-CONTEXT.json>" >&2
  exit 2
fi

SOURCE_CONTEXT="$2"
SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00000-of-00100.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RECOVERY_CONTRACT="$SCRIPT_DIR/incomplete-1000-recovery-source-v1.json"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" && -f "$RECOVERY_CONTRACT" ]] || { echo "The locked source manifest or incomplete recovery contract is missing." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
RUN_ID="cc-main-2026-30-local-standard1-incomplete-recover-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-incomplete-recovery-gate-${NONCE}-XXXXXX")"
BUNDLE="$TEMP_ROOT/bundle"

echo "GrowthSent incomplete 1,000-WAT recovery compilation gate (Ubuntu/WSL native)"
echo "Scope: exact 408-WAT local bundle build, Docker contract tests, and four Wrangler --dry-runs."
echo "Safety: the original 1,000-WAT run is referenced only for its audited completion inventory and remains read-only."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 408 \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$BUNDLE"

TEST_IMAGE="growthsent-standard1-incomplete-recovery-gate-${NONCE}"
docker build --tag "$TEST_IMAGE" "$BUNDLE/bundles/apac" >/dev/null
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" \
  tests/common_crawl_cloudflare_r2_standard1_regional_ramp.test.py

for REGION in apac enam wnam weur; do
  REGION_BUNDLE="$BUNDLE/bundles/$REGION"
  npm --prefix "$REGION_BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$REGION_BUNDLE/wrangler.jsonc"
done

python3 - "$BUNDLE/RUN-PLAN.json" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert plan["kind"] == "growthsent-cloudflare-r2-standard1-incomplete-recovery-plan"
assert plan["execution_profile"] == "regional-incomplete-recovery"
assert plan["task_count"] == 408
assert plan["max_concurrent_total"] == 16
assert plan["credential_policy"] == {
    "id": "regional-six-day-v1",
    "child_ttl_seconds": 518400,
    "start_guard_seconds": 10800,
}
assert [item["region"] for item in plan["regions"]] == ["APAC", "ENAM", "WNAM", "WEUR"]
assert [item["regional_task_count"] for item in plan["regions"]] == [102, 102, 102, 102]
assert all(item["max_concurrent"] == 4 and item["max_instances"] == 6 for item in plan["regions"])
assert plan["recovery"]["inventory"]["completion_marker_count"] == 592
assert len(plan["recovery"]["recovery_source_indexes"]) == 408
print("incomplete 1,000-WAT recovery local plan gate passed")
PY

echo "SUCCESS: the exact 408-WAT recovery plan compiled locally and passed four Wrangler dry-runs."
echo "Secret-free local plan: $BUNDLE/RUN-PLAN.json"
echo "Remote deployment and start require a separate explicit approval."
