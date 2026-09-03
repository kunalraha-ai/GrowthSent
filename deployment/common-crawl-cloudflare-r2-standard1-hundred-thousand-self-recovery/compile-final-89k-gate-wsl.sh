#!/usr/bin/env bash
# Build and validate the final remaining-89K self-recovery campaign locally.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
SOURCE_MANIFEST="${GROWTHSENT_HUNDRED_THOUSAND_SOURCE_MANIFEST:-$ROOT/deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json}"
FIRST_TEN_THOUSAND_MANIFEST="${GROWTHSENT_FIRST_TEN_THOUSAND_MANIFEST:-$ROOT/deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json}"
SHARD_TEN_MANIFEST="${GROWTHSENT_SHARD_TEN_MANIFEST:-$ROOT/deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00010-of-00100.json}"

for name in GROWTHSENT_FIRST_TEN_THOUSAND_AGGREGATE_CONTRACT GROWTHSENT_SHARD_TEN_RECOVERY_CONTRACT GROWTHSENT_SHARD_TEN_RECOVERY_CONTEXT GROWTHSENT_SHARD_TEN_RECOVERY_REPORT; do
  [[ -n "${!name:-}" ]] || { echo "Set $name to the secret-free verified artifact produced by the earlier run." >&2; exit 2; }
done
for path in "$SOURCE_MANIFEST" "$FIRST_TEN_THOUSAND_MANIFEST" "$SHARD_TEN_MANIFEST" "$GROWTHSENT_FIRST_TEN_THOUSAND_AGGREGATE_CONTRACT" "$GROWTHSENT_SHARD_TEN_RECOVERY_CONTRACT" "$GROWTHSENT_SHARD_TEN_RECOVERY_CONTEXT" "$GROWTHSENT_SHARD_TEN_RECOVERY_REPORT"; do
  [[ -f "$path" ]] || { echo "Missing required local artifact: $path" >&2; exit 1; }
done

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-s1-89kprep-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-remaining-89k-${RUN_ID}-XXXXXX")"
PROOF="$TEMP_ROOT/VERIFIED-REUSE-PROOF.json"
BUNDLE_DIRECTORY="$TEMP_ROOT/bundle"

echo "GrowthSent remaining 89,000-WAT self-recovery compilation gate (Ubuntu/WSL native)"
echo "Source: $SOURCE_MANIFEST"
echo "Scope: locally reconstruct a verified 11,000-WAT reuse proof, build a 45-lane/1,440-slot remaining-89K plan, build one representative Docker image, run contract tests, and perform two Wrangler dry-runs."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/prepare_verified_reuse_proof.py" \
  --source-manifest "$SOURCE_MANIFEST" \
  --first-ten-thousand-manifest "$FIRST_TEN_THOUSAND_MANIFEST" \
  --first-ten-thousand-aggregate-contract "$GROWTHSENT_FIRST_TEN_THOUSAND_AGGREGATE_CONTRACT" \
  --shard-ten-manifest "$SHARD_TEN_MANIFEST" \
  --shard-ten-recovery-contract "$GROWTHSENT_SHARD_TEN_RECOVERY_CONTRACT" \
  --shard-ten-recovery-context "$GROWTHSENT_SHARD_TEN_RECOVERY_CONTEXT" \
  --shard-ten-recovery-report "$GROWTHSENT_SHARD_TEN_RECOVERY_REPORT" \
  --output "$PROOF"

python3 "$SCRIPT_DIR/build_self_recovery_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --reuse-proof "$PROOF" \
  --output-dir "$BUNDLE_DIRECTORY"

TEST_IMAGE="growthsent-standard1-remaining-eighty-nine-thousand-${NONCE}"
docker build --tag "$TEST_IMAGE" "$BUNDLE_DIRECTORY/lanes/apac-01" >/dev/null
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" tests/common_crawl_cloudflare_r2_standard1_regional_ramp.test.py
docker run --rm --entrypoint python -v "$ROOT:/source:ro" -w /source "$TEST_IMAGE" tests/common_crawl_cloudflare_r2_standard1_hundred_thousand_self_recovery.test.py

for BUNDLE in "$BUNDLE_DIRECTORY/admission" "$BUNDLE_DIRECTORY/lanes/apac-01"; do
  npm --prefix "$BUNDLE" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config "$BUNDLE/wrangler.jsonc"
done

python3 - "$BUNDLE_DIRECTORY/SELF-RECOVERY-RUN-PLAN.json" "$BUNDLE_DIRECTORY/SELF-RECOVERY-POLICY.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
policy = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
payload = dict(plan)
payload.pop("plan_sha256", None)
assert hashlib.sha256((json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").rstrip("\n").encode("utf-8")).hexdigest() == plan["plan_sha256"]
assert plan["kind"] == "growthsent-cloudflare-r2-standard1-remaining-eighty-nine-thousand-self-recovery-plan-v1"
assert plan["source_manifest"]["input_count"] == 100000
assert plan["processing_window"]["source_index_start"] == 11000
assert plan["processing_window"]["source_index_end_exclusive"] == 100000
assert plan["processing_window"]["task_count"] == 89000
assert len(plan["lanes"]) == 45
assert plan["topology"]["max_concurrent_total"] == 1440
assert plan["topology"]["max_instances_per_lane"] == 32
assert all(lane["max_concurrent"] == 32 and lane["max_instances"] == 32 for lane in plan["lanes"])
assert plan["twenty_four_hour_envelope"]["planned_wall_seconds"] <= 86400
assert plan["remote_start"].startswith("disabled")
assert policy["authorized_fresh_recovery_required"]["remote_automation"].startswith("intentionally disabled")
print("remaining 89,000-WAT self-recovery compilation gate passed")
PY

echo "SUCCESS: the launch-disabled remaining-89,000-WAT self-recovery control plane compiled locally."
echo "Secret-free reuse proof: $PROOF"
echo "Secret-free future plan: $BUNDLE_DIRECTORY/SELF-RECOVERY-RUN-PLAN.json"
echo "Remote deployment and start remain intentionally unavailable from this gate."
