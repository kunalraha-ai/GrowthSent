#!/usr/bin/env bash
# Compile a fresh 128-container regional checkpoint locally. No remote side effects.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_HIGH_CAPACITY_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00010-of-00100.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing fresh locked 1,000-WAT checkpoint shard: $SOURCE_MANIFEST" >&2; exit 1; }
NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-standard1-regional-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-128-checkpoint-${RUN_ID}-XXXXXX")"
OUTPUT_ROOT="$TEMP_ROOT/bundle"

echo "GrowthSent regional standard-1 128-container checkpoint compilation gate (Ubuntu/WSL native)"
echo "Run ID: $RUN_ID"
echo "Scope: 1,000 fresh locked WATs, four regional Workers, 32 fixed active slots per region (128 total), 15-second slot ramp."
echo "Credential plan for a later approved run: six-day, write-only children scoped to four fresh regional prefixes; a three-hour pre-start expiry guard."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 1000 \
  --max-concurrent 32 \
  --execution-profile regional-128-capacity-checkpoint \
  --output-dir "$OUTPUT_ROOT"

TEST_IMAGE="growthsent-standard1-128-checkpoint-gate-${NONCE}"
docker build --tag "$TEST_IMAGE" "$OUTPUT_ROOT/bundles/apac" >/dev/null
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" \
  tests/common_crawl_cloudflare_r2_standard1_regional_ramp.test.py

for REGION in apac enam wnam weur; do
  BUNDLE="$OUTPUT_ROOT/bundles/$REGION"
  npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$BUNDLE/wrangler.jsonc"
done

python3 - "$OUTPUT_ROOT/RUN-PLAN.json" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert plan["kind"] == "growthsent-cloudflare-r2-standard1-regional-ramp-plan"
assert plan["execution_profile"] == "regional-128-capacity-checkpoint"
assert plan["task_count"] == 1000
assert plan["max_concurrent_total"] == 128
assert plan["credential_policy"] == {
    "id": "regional-six-day-v1",
    "child_ttl_seconds": 518400,
    "start_guard_seconds": 10800,
}
assert [item["region"] for item in plan["regions"]] == ["APAC", "ENAM", "WNAM", "WEUR"]
assert all(item["regional_task_count"] == 250 for item in plan["regions"])
assert all(item["max_concurrent"] == 32 and item["max_instances"] == 34 for item in plan["regions"])
print("regional standard-1 128-container checkpoint local plan gate passed")
PY

echo "SUCCESS: the 128-container checkpoint compiled locally and passed four Wrangler dry-runs."
echo "Secret-free run plan: $OUTPUT_ROOT/RUN-PLAN.json"
echo "Remote deployment and start require a separate explicit approval."
