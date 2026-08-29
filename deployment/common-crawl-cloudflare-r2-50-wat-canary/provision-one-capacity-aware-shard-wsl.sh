#!/usr/bin/env bash
# Launch exactly one fresh ten-WAT replacement shard.  This is intentionally
# capacity-aware: callers use it only after the preceding standard-4 Container
# has completed, verified, and been retired.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--approved-serial-shard" ]] || ! [[ "$2" =~ ^(01|02|04|05)$ ]]; then
  echo "Usage: $0 --approved-serial-shard <01|02|04|05>" >&2
  exit 2
fi

SHARD="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEN_WAT_DIR="$(cd -- "$SCRIPT_DIR/../common-crawl-cloudflare-r2-10-wat-canary" && pwd)"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || {
  echo "GROWTHSENT_50_REFERENCE_DIR must name the prepared local 50-WAT reference directory." >&2
  exit 1
}
REFERENCE_MANIFEST="$REFERENCE_DIR/shard-${SHARD}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
[[ -f "$REFERENCE_MANIFEST" ]] || {
  echo "Missing public-source reference manifest for shard $SHARD: $REFERENCE_MANIFEST" >&2
  exit 1
}

case "$SHARD" in
  01)
    REFERENCE_BASELINE_KEY="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
    ;;
  02|04|05)
    REFERENCE_BASELINE_KEY="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-${SHARD}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
    ;;
esac

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
CANARY_ID="cc-main-2026-30-${TIMESTAMP}-50-wat-serial-${NONCE}-s${SHARD}"
WORKER_NAME="growthsent-50serial-${NONCE}-s${SHARD}"

echo "GrowthSent capacity-aware one-shard replacement (Ubuntu/WSL native)"
echo "Shard: $SHARD"
echo "Canary ID: $CANARY_ID"
echo "Scope: exactly one fresh ten-WAT Container Worker, one HTTPS stream, 110-minute hard timeout."
echo "Precondition: no other standard-4 canary Container may be running."
echo "Destination: production/common-crawl/cloudflare-r2-canaries/v1/$CANARY_ID/"
read -r -p "Press Enter to continue: " _

GROWTHSENT_REFERENCE_MANIFEST="$REFERENCE_MANIFEST" \
GROWTHSENT_REFERENCE_BASELINE_KEY="$REFERENCE_BASELINE_KEY" \
GROWTHSENT_CANARY_ID="$CANARY_ID" \
GROWTHSENT_WORKER_NAME="$WORKER_NAME" \
bash "$TEN_WAT_DIR/provision-and-start-wsl.sh" --approved-ten-wat-canary
