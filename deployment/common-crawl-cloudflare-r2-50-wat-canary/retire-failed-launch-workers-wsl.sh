#!/usr/bin/env bash
# Apply a Durable Object deletion migration to the five failed/successful
# temporary Workers.  It intentionally never contacts R2 and does not delete
# any immutable canary objects.  The Worker scripts are removed separately,
# only after this migration succeeds and is inspected.
set -euo pipefail

if [[ "${1:-}" == "--approved-retire-workers" && $# -eq 1 ]]; then
  WORKERS=(
    growthsent-50wat-e26d413e-s01
    growthsent-50wat-e26d413e-s02
    growthsent-50wat-e26d413e-s03
    growthsent-50wat-e26d413e-s04
    growthsent-50wat-e26d413e-s05
  )
elif [[ "${1:-}" == "--approved-retire-worker" && $# -eq 2 ]] && [[ "$2" =~ ^growthsent-50repair-[a-f0-9]{8}-s(01|02|04|05)$ ]]; then
  WORKERS=("$2")
else
  echo "Usage: $0 --approved-retire-workers | --approved-retire-worker <growthsent-50repair-...-s01|s02|s04|s05>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
PARENT_ID="cc-main-2026-30-20260828t124720z-50-wat-cf-e26d413e"
CLEANUP_DIR="$SCRIPT_DIR/cleanup-worker"
WRANGLER=(npx --offline --yes wrangler@4.126.0)

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ -f "$CLEANUP_DIR/wrangler.jsonc" && -f "$CLEANUP_DIR/src/index.ts" ]] || {
  echo "The checked-in temporary Worker cleanup bundle is missing." >&2
  exit 1
}

echo "GrowthSent 50-WAT temporary Worker retirement (Ubuntu/WSL native)"
echo "Scope: retire only the selected temporary Workers from $PARENT_ID."
echo "R2 is not contacted; all immutable canary and audit objects are preserved."
echo "Each Worker first receives a v2 Durable Object deletion migration."
read -r -p "Press Enter to continue: " _

for WORKER_NAME in "${WORKERS[@]}"; do
  echo "Applying DO retirement migration to $WORKER_NAME..."
  (
    cd "$CLEANUP_DIR"
    "${WRANGLER[@]}" deploy --config wrangler.jsonc --name "$WORKER_NAME"
  )
  printf '{"stage":"durable_object_retired","worker":"%s","parent_canary_id":"%s"}\n' "$WORKER_NAME" "$PARENT_ID"
done

echo "SUCCESS: all selected Durable Object retirement migrations deployed."
echo "Do not reuse these Worker names. Their script deletion and read-only orphan check are the next separate step."
