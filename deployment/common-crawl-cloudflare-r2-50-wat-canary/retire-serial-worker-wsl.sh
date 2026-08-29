#!/usr/bin/env bash
# Retire exactly one verified capacity-aware serial canary Worker.  This only
# applies the reviewed Durable Object deletion migration; it never contacts R2.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--approved-retire-serial-worker" ]] || ! [[ "$2" =~ ^growthsent-50serial-[a-f0-9]{8}-s(02|04|05)$ ]]; then
  echo "Usage: $0 --approved-retire-serial-worker <growthsent-50serial-xxxxxxxx-s02|s04|s05>" >&2
  exit 2
fi

WORKER="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP_DIR="$SCRIPT_DIR/cleanup-worker"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
[[ -f "$CLEANUP_DIR/wrangler.jsonc" && -f "$CLEANUP_DIR/src/index.ts" ]] || {
  echo "The reviewed Durable Object retirement bundle is missing." >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "GrowthSent serial temporary Worker retirement (Ubuntu/WSL native)"
echo "Scope: retire only $WORKER. R2 is not contacted; immutable canary output is preserved."
echo "A v2 Durable Object deletion migration is required before the script may be deleted."
read -r -p "Press Enter to continue: " _

(
  cd "$CLEANUP_DIR"
  npx --offline --yes wrangler@4.126.0 deploy --name "$WORKER" --config wrangler.jsonc
)

printf '{"stage":"durable_object_retired","worker":"%s"}\n' "$WORKER"
echo "SUCCESS: the selected serial Worker Durable Object retirement migration deployed."
