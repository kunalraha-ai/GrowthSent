#!/usr/bin/env bash
# Local-only compilation gate for the one-lane ENAM recovery.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--source-context" || ! -f "$2" ]]; then
  echo "Usage: $0 --source-context <original-REGIONAL-RAMP-CONTEXT.json>" >&2
  exit 2
fi

SOURCE_CONTEXT="$2"
SOURCE_MANIFEST="${GROWTHSENT_REGIONAL_SOURCE_MANIFEST:-deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000-shards/shard-00000-of-00100.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker; do command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }; done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RECOVERY_CONTRACT="$SCRIPT_DIR/enam-recovery-source-v1.json"
if [[ "$SOURCE_MANIFEST" != /* ]]; then SOURCE_MANIFEST="$ROOT/$SOURCE_MANIFEST"; fi
[[ -f "$SOURCE_MANIFEST" && -f "$RECOVERY_CONTRACT" ]] || { echo "The locked source manifest or ENAM recovery contract is missing." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
RUN_ID="cc-main-2026-30-local-standard1-enam-recover-${NONCE}"
TEMP_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-enam-recovery-gate-${NONCE}-XXXXXX")"
BUNDLE="$TEMP_ROOT/bundle"

echo "GrowthSent isolated ENAM recovery compilation gate (Ubuntu/WSL native)"
echo "Scope: exact 18-WAT local bundle build plus Wrangler --dry-run only."
echo "No Cloudflare API call, Worker deployment, Container start, R2 object, or credential mint occurs."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundles.py" \
  --run-id "$RUN_ID" \
  --source-manifest "$SOURCE_MANIFEST" \
  --task-count 18 \
  --recovery-contract "$RECOVERY_CONTRACT" \
  --source-run-context "$SOURCE_CONTEXT" \
  --output-dir "$BUNDLE"
npm --prefix "$BUNDLE/bundles/enam" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
(cd "$BUNDLE/bundles/enam" && npx --offline --yes wrangler@4.126.0 deploy --dry-run --config wrangler.jsonc)
echo "SUCCESS: isolated ENAM 18-WAT recovery bundle compiled locally."
echo "Secret-free local bundle: $BUNDLE"
