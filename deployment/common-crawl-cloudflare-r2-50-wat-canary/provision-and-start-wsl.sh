#!/usr/bin/env bash
# Five-way fan-out launcher for the bounded 50-WAT Cloudflare Container
# canary. Each shard preserves the reviewed ten-WAT runner and receives a
# unique Worker, Container, R2 prefix, trigger secret, and child credential.
set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "--preflight-only" && "$MODE" != "--approved-fifty-wat-canary" ]] || [[ $# -ne 1 ]]; then
  echo "Usage: $0 --preflight-only|--approved-fifty-wat-canary" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TEN_WAT_PROVISIONER="$ROOT/deployment/common-crawl-cloudflare-r2-10-wat-canary/provision-and-start-wsl.sh"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || { echo "GROWTHSENT_50_REFERENCE_DIR must name the prepared local reference directory." >&2; exit 1; }
[[ -f "$TEN_WAT_PROVISIONER" ]] || { echo "Missing ten-WAT provisioner: $TEN_WAT_PROVISIONER" >&2; exit 1; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }

for shard in 01 02 03 04 05; do
  [[ -f "$REFERENCE_DIR/shard-$shard/PUBLIC-SOURCE-BASELINE-MANIFEST.json" ]] || {
    echo "Missing prepared local reference baseline for shard $shard." >&2
    exit 1
  }
done

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
PARENT_ID="cc-main-2026-30-${TIMESTAMP}-50-wat-cf-${NONCE}"
RUN_DIRECTORY="$(mktemp -d -t "growthsent-cloudflare-50-wat-${PARENT_ID}-XXXXXX")"

echo "GrowthSent Cloudflare Container 50-WAT parallel canary (Ubuntu/WSL native)"
echo "Parent canary ID: $PARENT_ID"
echo "Scope: five distinct ten-WAT shards, five temporary Workers/Containers, five HTTPS streams total, 110-minute hard timeout per shard."
echo "R2 destinations: five isolated child canary prefixes; no production prefix is writable."
if [[ "$MODE" == "--preflight-only" ]]; then
  echo "Mode: all five child credentials and audit baselines are checked; no Worker, Container, or canary R2 object will be created."
else
  echo "Each shard is preflighted first. Only if all five preflights pass are exactly five Containers started in parallel."
fi
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }

run_shard() {
  local shard="$1"
  local child_mode="$2"
  local canary_id="${PARENT_ID}-s${shard}"
  local worker_name="growthsent-50wat-${NONCE}-s${shard}"
  local reference_manifest="$REFERENCE_DIR/shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  local audit_manifest_key="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  if [[ "$shard" == "01" ]]; then
    audit_manifest_key="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  fi
  printf '\n%s\n' "$PARENT_TOKEN" | \
    GROWTHSENT_WSL_NODE_BIN="$WSL_NODE_BIN" \
    GROWTHSENT_CANARY_ID="$canary_id" \
    GROWTHSENT_WORKER_NAME="$worker_name" \
    GROWTHSENT_REFERENCE_MANIFEST="$reference_manifest" \
    GROWTHSENT_REFERENCE_BASELINE_KEY="$audit_manifest_key" \
    bash "$TEN_WAT_PROVISIONER" "$child_mode"
}

wait_for_shards() {
  local label="$1"
  local failed=0
  local shard
  for shard in 01 02 03 04 05; do
    if ! wait "${PIDS[$shard]}"; then
      failed=1
      echo "Shard $shard $label failed; safe log: ${RUN_DIRECTORY}/${label}-shard-${shard}.log" >&2
    fi
  done
  return "$failed"
}

declare -A PIDS
for shard in 01 02 03 04 05; do
  run_shard "$shard" "--preflight-only" >"${RUN_DIRECTORY}/preflight-shard-${shard}.log" 2>&1 &
  PIDS[$shard]=$!
done
if ! wait_for_shards "preflight"; then
  unset PARENT_TOKEN
  echo "At least one preflight failed. No Worker or Container was deployed." >&2
  exit 1
fi
unset PIDS
declare -A PIDS
echo '{"stage":"all_shards_preflighted","shard_count":5,"worker_deployed":false,"container_started":false}'

if [[ "$MODE" == "--preflight-only" ]]; then
  unset PARENT_TOKEN
  echo "SUCCESS: all five shard preflights passed."
  echo "Safe logs: $RUN_DIRECTORY"
  exit 0
fi

for shard in 01 02 03 04 05; do
  run_shard "$shard" "--approved-ten-wat-canary" >"${RUN_DIRECTORY}/launch-shard-${shard}.log" 2>&1 &
  PIDS[$shard]=$!
done
if ! wait_for_shards "launch"; then
  unset PARENT_TOKEN
  echo "One or more shard launchers failed. Do not rerun this launcher: inspect the safe logs because another shard may already be running." >&2
  exit 1
fi
unset PARENT_TOKEN
echo "SUCCESS: exactly five parallel ten-WAT Container starts were accepted."
echo "Parent canary ID: $PARENT_ID"
echo "Safe logs (no secrets): $RUN_DIRECTORY"
echo "Do not run this launcher again."
