#!/usr/bin/env bash
# Read-only verifier for all five child canaries in one bounded 50-WAT fan-out
# run. It mints short-lived local read-only credentials only and performs no
# Worker, Container, or R2 mutation.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--parent-canary-id" ]] || ! [[ "$2" =~ ^cc-main-2026-30-[a-z0-9-]+-50-wat-cf-[0-9a-f]{8}$ ]]; then
  echo "Usage: GROWTHSENT_50_REFERENCE_DIR=<prepared-reference-directory> $0 --parent-canary-id <cc-main-2026-30-...-50-wat-cf-xxxxxxxx>" >&2
  exit 2
fi

PARENT_ID="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TEN_WAT_VERIFIER="$ROOT/deployment/common-crawl-cloudflare-r2-10-wat-canary/verify-canary-wsl.sh"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"
VERIFY_DIRECTORY="$(mktemp -d -t "growthsent-cloudflare-50-wat-verify-${PARENT_ID}-XXXXXX")"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || { echo "GROWTHSENT_50_REFERENCE_DIR must name the prepared local reference directory." >&2; exit 1; }
[[ -f "$TEN_WAT_VERIFIER" ]] || { echo "Missing ten-WAT verifier: $TEN_WAT_VERIFIER" >&2; exit 1; }
for shard in 01 02 03 04 05; do
  [[ -f "$REFERENCE_DIR/shard-$shard/PUBLIC-SOURCE-BASELINE-MANIFEST.json" ]] || {
    echo "Missing prepared local reference baseline for shard $shard." >&2
    exit 1
  }
done

echo "GrowthSent Cloudflare Container 50-WAT read-only verification (Ubuntu/WSL native)"
echo "Parent canary ID: $PARENT_ID"
echo "Scope: five isolated child prefixes and five immutable public-source baselines."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }

failures=0
for shard in 01 02 03 04 05; do
  child_id="${PARENT_ID}-s${shard}"
  reference_manifest="$REFERENCE_DIR/shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  audit_manifest_key="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  if [[ "$shard" == "01" ]]; then
    audit_manifest_key="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-10-wat/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  fi
  echo "Verifying shard $shard: $child_id"
  set +e
  printf '\n%s\n' "$PARENT_TOKEN" | \
    GROWTHSENT_REFERENCE_MANIFEST="$reference_manifest" \
    GROWTHSENT_AUDIT_MANIFEST_KEY="$audit_manifest_key" \
    bash "$TEN_WAT_VERIFIER" --canary-id "$child_id" \
    >"$VERIFY_DIRECTORY/shard-${shard}.log" 2>&1
  result=$?
  set -e
  if [[ $result -ne 0 ]]; then
    failures=$((failures + 1))
    echo "Shard $shard verification failed; safe log: $VERIFY_DIRECTORY/shard-${shard}.log" >&2
  fi
done

unset PARENT_TOKEN
if [[ $failures -ne 0 ]]; then
  echo "Verification failed for $failures shard(s). No Worker, Container, or R2 object was changed." >&2
  exit 1
fi
echo "SUCCESS: all five child canaries verified against their distinct public-source baselines."
echo "Safe verifier logs: $VERIFY_DIRECTORY"
