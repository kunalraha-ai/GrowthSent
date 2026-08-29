#!/usr/bin/env bash
# Publish the four new local 10-WAT reference manifests. Shard 1 already uses
# the verified public-source baseline. This is an audit-only operation: it
# never deploys a Worker or starts a Container.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: GROWTHSENT_50_REFERENCE_DIR=<prepared-reference-directory> $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PUBLISHER="$ROOT/deployment/common-crawl-cloudflare-r2-10-wat-canary/publish-public-baseline-v2-wsl.sh"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || { echo "GROWTHSENT_50_REFERENCE_DIR must name a prepared local reference directory." >&2; exit 1; }
[[ -f "$PUBLISHER" ]] || { echo "Missing baseline publisher: $PUBLISHER" >&2; exit 1; }

for shard in 01 02 03 04 05; do
  [[ -f "$REFERENCE_DIR/shard-$shard/PUBLIC-SOURCE-BASELINE-MANIFEST.json" ]] || {
    echo "Missing local reference manifest for shard $shard." >&2
    exit 1
  }
done

echo "GrowthSent 50-WAT reference publication (Ubuntu/WSL native)"
echo "Scope: four immutable audit manifests and four completion markers; no Worker or Container."
echo "Reference directory: $REFERENCE_DIR"
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }

for shard in 02 03 04 05; do
  manifest="$REFERENCE_DIR/shard-$shard/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  audit_prefix="production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-$shard/"
  printf '{"stage":"publish_shard","shard":%s,"audit_prefix":"%s"}\n' "$((10#$shard))" "$audit_prefix"
  set +e
  printf '\n%s\n' "$PARENT_TOKEN" | \
    GROWTHSENT_REFERENCE_MANIFEST="$manifest" \
    GROWTHSENT_AUDIT_PREFIX="$audit_prefix" \
    bash "$PUBLISHER"
  result=$?
  set -e
  if [[ $result -ne 0 ]]; then
    unset PARENT_TOKEN
    echo "Reference publication stopped at shard $shard. No Container was started." >&2
    exit "$result"
  fi
done

unset PARENT_TOKEN
echo "SUCCESS: four new immutable public-source baseline shards were published; shard 1 reuses the verified baseline."
