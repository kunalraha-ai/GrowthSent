#!/usr/bin/env bash
# Compile the 256-slot 10,000-WAT plan locally. This has no remote side effects.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked 10,000-WAT base manifest: $SOURCE_MANIFEST" >&2; exit 1; }
NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-256-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-256-ten-thousand-${RUN_ID}-XXXXXX")"
OUTPUT_ROOT="$TEMP_ROOT/bundle"
LANES=(apac-a apac-b enam-a enam-b wnam-a wnam-b weur-a weur-b)

echo "GrowthSent regional standard-1 256-slot 10,000-WAT compilation gate (Ubuntu/WSL native)"
echo "Run ID: $RUN_ID"
echo "Scope: 10,000 locked WATs, eight regional Workers, 32 fixed Containers per Worker (256 total)."
echo "Each physical region has two isolated 32-slot lanes. Each lane starts at most once every 30s, with a sibling offset to keep regional allocation gradual."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 10000 \
  --max-concurrent 32 \
  --start-spacing-seconds 30 \
  --execution-profile regional-256-ten-thousand-wat \
  --output-dir "$OUTPUT_ROOT"

TEST_IMAGE="growthsent-standard1-256-ten-thousand-gate-${NONCE}"
docker build --tag "$TEST_IMAGE" "$OUTPUT_ROOT/bundles/apac-a" >/dev/null
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" \
  tests/common_crawl_cloudflare_r2_standard1_regional_ramp.test.py

for LANE in "${LANES[@]}"; do
  BUNDLE="$OUTPUT_ROOT/bundles/$LANE"
  npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$BUNDLE/wrangler.jsonc"
done

python3 - "$OUTPUT_ROOT/RUN-PLAN.json" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert plan["kind"] == "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan"
assert plan["execution_profile"] == "regional-256-ten-thousand-wat"
assert plan["task_count"] == 10000
assert plan["max_concurrent_total"] == 256
assert plan["start_spacing_seconds_per_lane"] == 30
assert [item["region"] for item in plan["regions"]] == ["APAC-A", "APAC-B", "ENAM-A", "ENAM-B", "WNAM-A", "WNAM-B", "WEUR-A", "WEUR-B"]
assert [item["placement_constraint"] for item in plan["regions"]] == ["APAC", "APAC", "ENAM", "ENAM", "WNAM", "WNAM", "WEUR", "WEUR"]
assert [item["initial_start_delay_seconds"] for item in plan["regions"]] == [0, 10, 0, 10, 0, 10, 0, 10]
assert all(item["regional_task_count"] == 1250 and item["max_concurrent"] == 32 and item["max_instances"] == 34 for item in plan["regions"])
print("regional standard-1 256-slot 10,000-WAT local plan gate passed")
PY

echo "SUCCESS: the 256-slot 10,000-WAT plan compiled locally and passed eight Wrangler dry-runs."
echo "Secret-free run plan: $OUTPUT_ROOT/RUN-PLAN.json"
echo "Remote deployment and start require a separate explicit approval."
