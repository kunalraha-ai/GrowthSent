#!/usr/bin/env bash
# Retire exactly the four temporary Workers created for one regional capacity
# run. This applies only a Durable Object deletion migration: it never
# contacts R2, deletes no immutable output, and does not delete Worker scripts.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--approved-retire-run" ]] || ! [[ "$2" =~ ^cc-main-2026-30-[0-9]{8}t[0-9]{6}z-standard1-(regional|remaining)-[a-f0-9]{8}$ ]]; then
  echo "Usage: $0 --approved-retire-run <cc-main-2026-30-YYYYMMDDtHHMMSSz-standard1-(regional|remaining)-xxxxxxxx>" >&2
  exit 2
fi

RUN_ID="$2"
NONCE="${RUN_ID##*-}"
WORKERS=(
  "growthsent-regional-${NONCE}-apac"
  "growthsent-regional-${NONCE}-enam"
  "growthsent-regional-${NONCE}-wnam"
  "growthsent-regional-${NONCE}-weur"
)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
CLEANUP_DIR="$SCRIPT_DIR/cleanup-worker"
WRANGLER=(npx --offline --yes wrangler@4.126.0)

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
[[ -f "$CLEANUP_DIR/wrangler.jsonc" && -f "$CLEANUP_DIR/src/index.ts" ]] || {
  echo "The regional Worker cleanup bundle is missing." >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "GrowthSent regional standard-1 temporary Worker retirement (Ubuntu/WSL native)"
echo "Run ID: $RUN_ID"
echo "Scope: retire only these four temporary Workers: ${WORKERS[*]}"
echo "R2 is not contacted; immutable canary objects are preserved."
echo "Each Worker first receives the v2 Durable Object deletion migration."
read -r -p "Press Enter to continue: " _

for WORKER in "${WORKERS[@]}"; do
  echo "Applying Durable Object retirement migration to $WORKER..."
  (
    cd "$CLEANUP_DIR"
    "${WRANGLER[@]}" deploy --config wrangler.jsonc --name "$WORKER"
  )
  printf '{"stage":"durable_object_retired","worker":"%s","run_id":"%s"}\n' "$WORKER" "$RUN_ID"
done

echo "SUCCESS: all four regional Durable Object retirement migrations deployed."
echo "Do not reuse these Worker names. Script deletion and an orphan check remain separate actions."
