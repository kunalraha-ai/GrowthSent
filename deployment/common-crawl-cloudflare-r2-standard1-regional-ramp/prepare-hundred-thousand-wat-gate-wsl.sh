#!/usr/bin/env bash
# Prepare and locally validate a 100,000-WAT campaign without remote side effects.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SOURCE_MANIFEST="${GROWTHSENT_HUNDRED_THOUSAND_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Missing locked 100,000-WAT base manifest: $SOURCE_MANIFEST" >&2; exit 1; }
NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
PROOF_RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-256prep-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-hundred-thousand-${PROOF_RUN_ID}-XXXXXX")"
CAMPAIGN_DIRECTORY="$TEMP_ROOT/campaign"
PROOF_DIRECTORY="$TEMP_ROOT/proof"
LANES=(apac-a apac-b enam-a enam-b wnam-a wnam-b weur-a weur-b)

echo "GrowthSent regional standard-1 100,000-WAT campaign preparation gate (Ubuntu/WSL native)"
echo "Source: $SOURCE_MANIFEST"
echo "Scope: ten immutable 10,000-WAT waves; each future wave reuses the separately reviewed 256-slot, eight-lane topology."
echo "This only derives local manifests, builds one representative local bundle, runs the contract suite, and performs eight Wrangler dry-runs."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/prepare_hundred_thousand_campaign.py" \
  --source-manifest "$SOURCE_MANIFEST" \
  --output-dir "$CAMPAIGN_DIRECTORY"

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$PROOF_RUN_ID" \
  --source-manifest "$CAMPAIGN_DIRECTORY/waves/wave-00-of-10.json" \
  --task-count 10000 \
  --max-concurrent 32 \
  --start-spacing-seconds 30 \
  --execution-profile regional-256-ten-thousand-wat \
  --output-dir "$PROOF_DIRECTORY"

TEST_IMAGE="growthsent-standard1-hundred-thousand-gate-${NONCE}"
docker build --tag "$TEST_IMAGE" "$PROOF_DIRECTORY/bundles/apac-a" >/dev/null
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" \
  tests/common_crawl_cloudflare_r2_standard1_regional_ramp.test.py

for LANE in "${LANES[@]}"; do
  BUNDLE="$PROOF_DIRECTORY/bundles/$LANE"
  npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$BUNDLE/wrangler.jsonc"
done

python3 - "$CAMPAIGN_DIRECTORY/CAMPAIGN-PLAN.json" "$PROOF_DIRECTORY/RUN-PLAN.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

campaign = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
proof = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
assert campaign["kind"] == "growthsent-cloudflare-r2-standard1-hundred-thousand-campaign-v1"
assert campaign["source"]["input_count"] == 100000
assert campaign["wave_count"] == 10
assert campaign["wave_task_count"] == 10000
assert campaign["execution_profile"] == "regional-256-ten-thousand-wat"
assert campaign["topology"]["max_concurrent_total"] == 256
assert len(campaign["waves"]) == 10
assert [wave["wave_index"] for wave in campaign["waves"]] == list(range(10))
assert all(wave["input_count"] == 10000 for wave in campaign["waves"])
assert proof["kind"] == "growthsent-cloudflare-r2-standard1-256-ten-thousand-plan"
assert proof["task_count"] == 10000
assert proof["max_concurrent_total"] == 256
print("regional standard-1 100,000-WAT campaign preparation gate passed")
PY

echo "SUCCESS: the launch-disabled 100,000-WAT campaign is prepared and locally validated."
echo "Secret-free campaign plan: $CAMPAIGN_DIRECTORY/CAMPAIGN-PLAN.json"
echo "The ten wave manifests are in: $CAMPAIGN_DIRECTORY/waves/"
echo "Remote deployment and start remain intentionally unavailable from this gate."
