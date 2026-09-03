#!/usr/bin/env bash
# Retire exactly one verified ENAM recovery Worker after its R2 output is kept.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--approved-retire-enam-recovery" ]] || ! [[ "$2" =~ ^cc-main-2026-30-[0-9]{8}t[0-9]{6}z-standard1-enam-recover-[a-f0-9]{8}$ ]]; then
  echo "Usage: $0 --approved-retire-enam-recovery <cc-main-2026-30-YYYYMMDDtHHMMSSz-standard1-enam-recover-xxxxxxxx>" >&2
  exit 2
fi

RUN_ID="$2"
NONCE="${RUN_ID##*-}"
WORKER="growthsent-regional-${NONCE}-enam"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
CLEANUP_DIR="$SCRIPT_DIR/cleanup-worker"
WRANGLER=(npx --offline --yes wrangler@4.126.0)

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
[[ -f "$CLEANUP_DIR/wrangler.jsonc" && -f "$CLEANUP_DIR/src/index.ts" ]] || { echo "The regional Worker cleanup bundle is missing." >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "GrowthSent ENAM recovery Worker retirement (Ubuntu/WSL native)"
echo "Run ID: $RUN_ID"
echo "Scope: retire only $WORKER after read-only recovery verification. R2 is not contacted and immutable output is preserved."
read -r -p "Press Enter to continue: " _

(
  cd "$CLEANUP_DIR"
  "${WRANGLER[@]}" deploy --config wrangler.jsonc --name "$WORKER"
)
printf '{"stage":"durable_object_retired","worker":"%s","run_id":"%s"}\n' "$WORKER" "$RUN_ID"
echo "SUCCESS: the ENAM recovery Worker Durable Object retirement migration deployed."
echo "Do not reuse this Worker name. Script deletion and an orphan check remain separate actions."
