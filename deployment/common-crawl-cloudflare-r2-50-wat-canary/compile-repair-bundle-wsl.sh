#!/usr/bin/env bash
# Build and Cloudflare-dry-run the repaired Container Worker bundle without
# creating a Worker, Container, R2 object, or temporary R2 credential.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEN_WAT_DIR="$(cd -- "$SCRIPT_DIR/../common-crawl-cloudflare-r2-10-wat-canary" && pwd)"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -n "$REFERENCE_DIR" && -d "$REFERENCE_DIR" ]] || {
  echo "GROWTHSENT_50_REFERENCE_DIR must name the prepared local 50-WAT reference directory." >&2
  exit 1
}
REFERENCE_MANIFEST="$REFERENCE_DIR/shard-01/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
[[ -f "$REFERENCE_MANIFEST" ]] || {
  echo "Missing shard-01 public-source reference manifest: $REFERENCE_MANIFEST" >&2
  exit 1
}
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for command in node npm npx python3 docker od date; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
RUN_ID="cc-main-2026-30-${TIMESTAMP}-compile-${NONCE}"
WORKER_NAME="growthsent-compile-${NONCE}"
BUNDLE_ROOT="$(mktemp -d -t "growthsent-cloudflare-compile-${NONCE}-XXXXXX")"
BUNDLE_DIRECTORY="$BUNDLE_ROOT/bundle"

echo "GrowthSent repaired Container bundle compilation gate (Ubuntu/WSL native)"
echo "Scope: local Docker image build plus Wrangler --dry-run only."
echo "No Worker, Container, R2 object, or temporary R2 credential will be created."
echo "Bundle directory: $BUNDLE_DIRECTORY"
read -r -p "Press Enter to continue: " _

python3 "$TEN_WAT_DIR/build_bundle.py" \
  --run-id "$RUN_ID" \
  --worker-name "$WORKER_NAME" \
  --container-name "$WORKER_NAME" \
  --reference-manifest "$REFERENCE_MANIFEST" \
  --output-dir "$BUNDLE_DIRECTORY"
npm --prefix "$BUNDLE_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null

(
  cd "$BUNDLE_DIRECTORY"
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config wrangler.jsonc
)

echo "SUCCESS: repaired Worker bundle compiled and passed the Wrangler dry-run gate."
echo "Bundle directory (no secrets): $BUNDLE_DIRECTORY"
