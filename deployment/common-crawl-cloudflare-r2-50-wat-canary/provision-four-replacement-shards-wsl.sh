#!/usr/bin/env bash
# Launch only the four unprocessed shards from the failed five-way start.
# Every replacement uses a fresh Worker and isolated R2 prefix.  Cold starts
# are deliberately staggered; after acceptance, all Containers run in parallel.
set -euo pipefail

if [[ "${1:-}" != "--approved-four-shard-replacement" || $# -ne 1 ]]; then
  echo "Usage: $0 --approved-four-shard-replacement" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEN_WAT_LAUNCHER="$SCRIPT_DIR/../common-crawl-cloudflare-r2-10-wat-canary/provision-and-start-wsl.sh"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
START_STAGGER_SECONDS="${GROWTHSENT_REPAIR_START_STAGGER_SECONDS:-15}"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || {
  echo "GROWTHSENT_50_REFERENCE_DIR must name the prepared local reference directory." >&2
  exit 1
}
[[ -x "$TEN_WAT_LAUNCHER" ]] || { echo "Missing reviewed ten-WAT WSL launcher: $TEN_WAT_LAUNCHER" >&2; exit 1; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
[[ "$START_STAGGER_SECONDS" =~ ^[1-9][0-9]*$ ]] && (( START_STAGGER_SECONDS >= 10 && START_STAGGER_SECONDS <= 60 )) || {
  echo "GROWTHSENT_REPAIR_START_STAGGER_SECONDS must be an integer from 10 to 60." >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for SHARD in 01 02 04 05; do
  [[ -f "$REFERENCE_DIR/shard-$SHARD/PUBLIC-SOURCE-BASELINE-MANIFEST.json" ]] || {
    echo "Missing local baseline for replacement shard $SHARD." >&2
    exit 1
  }
done

audit_key() {
  case "$1" in
    01) printf '%s\n' "production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/PUBLIC-SOURCE-BASELINE-MANIFEST.json" ;;
    02|04|05) printf 'production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-%s/PUBLIC-SOURCE-BASELINE-MANIFEST.json\n' "$1" ;;
    *) return 1 ;;
  esac
}

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
PARENT_ID="cc-main-2026-30-${TIMESTAMP}-50-wat-repair-${NONCE}"
RUN_DIRECTORY="$(mktemp -d -t "growthsent-cloudflare-50-repair-${PARENT_ID}-XXXXXX")"

echo "GrowthSent Cloudflare Container four-shard replacement (Ubuntu/WSL native)"
echo "Parent repair ID: $PARENT_ID"
echo "Scope: shards 01, 02, 04, 05 only; four temporary Workers/Containers; one HTTPS stream per Container."
echo "Each shard retains the 110-minute hard timeout. Cold-start requests are staggered by ${START_STAGGER_SECONDS}s; processing remains parallel after acceptance."
echo "R2 destinations: four fresh isolated child prefixes. The verified original shard 03 is not modified."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
if [[ -z "$PARENT_TOKEN" ]]; then
  echo "A parent Cloudflare API token is required." >&2
  exit 1
fi

run_child() {
  local mode="$1"
  local shard="$2"
  local log_file="$3"
  local canary_id="${PARENT_ID}-s${shard}"
  local worker_name="growthsent-50repair-${NONCE}-s${shard}"
  local reference_manifest="$REFERENCE_DIR/shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  local reference_key
  reference_key="$(audit_key "$shard")"
  set +e
  # The child launcher has two reads: its confirmation followed by the hidden
  # token prompt.  The final newline is required so Bash treats that hidden
  # read as successful rather than EOF.
  printf '\n%s\n' "$PARENT_TOKEN" | \
    GROWTHSENT_CANARY_ID="$canary_id" \
    GROWTHSENT_WORKER_NAME="$worker_name" \
    GROWTHSENT_REFERENCE_MANIFEST="$reference_manifest" \
    GROWTHSENT_REFERENCE_BASELINE_KEY="$reference_key" \
    bash "$TEN_WAT_LAUNCHER" "$mode" >"$log_file" 2>&1
  local result=$?
  set -e
  return "$result"
}

for SHARD in 01 02 04 05; do
  LOG_FILE="$RUN_DIRECTORY/preflight-shard-${SHARD}.log"
  if ! run_child --preflight-only "$SHARD" "$LOG_FILE"; then
    unset PARENT_TOKEN
    echo "Replacement shard $SHARD preflight failed; no replacement Worker was deployed. Safe log: $LOG_FILE" >&2
    exit 1
  fi
  grep -Fq '"status":"preflight_ok"' "$LOG_FILE" || {
    unset PARENT_TOKEN
    echo "Replacement shard $SHARD preflight lacked the required success marker. Safe log: $LOG_FILE" >&2
    exit 1
  }
done
printf '{"stage":"all_replacement_shards_preflighted","shard_count":4,"worker_deployed":false,"container_started":false}\n'

for SHARD in 01 02 04 05; do
  LOG_FILE="$RUN_DIRECTORY/launch-shard-${SHARD}.log"
  if ! run_child --approved-ten-wat-canary "$SHARD" "$LOG_FILE"; then
    unset PARENT_TOKEN
    echo "Replacement shard $SHARD launch failed. Do not rerun this launcher; inspect safe log: $LOG_FILE" >&2
    exit 1
  fi
  grep -Fq '"status":"live_start_accepted"' "$LOG_FILE" || {
    unset PARENT_TOKEN
    echo "Replacement shard $SHARD did not report an accepted start. Do not rerun this launcher; inspect safe log: $LOG_FILE" >&2
    exit 1
  }
  printf '{"stage":"replacement_shard_start_accepted","shard":%s,"canary_id":"%s-s%s"}\n' "$((10#$SHARD))" "$PARENT_ID" "$SHARD"
  if [[ "$SHARD" != "05" ]]; then
    sleep "$START_STAGGER_SECONDS"
  fi
done

unset PARENT_TOKEN
printf '{"status":"replacement_live_starts_accepted","parent_repair_id":"%s","shard_count":4,"run_directory":"%s"}\n' "$PARENT_ID" "$RUN_DIRECTORY"
echo "Exactly four staggered replacement Container starts were accepted. Do not rerun this launcher."
