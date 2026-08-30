#!/usr/bin/env bash
# Provision and start exactly one approved standard-1 one-WAT benchmark.
set -euo pipefail

if [[ $# -ne 1 || "$1" != "--approved-one-wat-standard1-benchmark" ]]; then
  echo "Usage: $0 --approved-one-wat-standard1-benchmark" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-}"
REFERENCE_BASELINE_KEY="${GROWTHSENT_REFERENCE_BASELINE_KEY:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -n "$REFERENCE_MANIFEST" && -f "$REFERENCE_MANIFEST" ]] || { echo "Set GROWTHSENT_REFERENCE_MANIFEST to the reviewed local baseline manifest." >&2; exit 1; }
[[ "$REFERENCE_BASELINE_KEY" =~ ^production/common-crawl/audit/public-source-baseline/v2/[a-z0-9][a-z0-9-]{0,63}/PUBLIC-SOURCE-BASELINE-MANIFEST\.json$ ]] || {
  echo "Set GROWTHSENT_REFERENCE_BASELINE_KEY to its exact published R2 public-source-baseline v2 key." >&2
  exit 1
}
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in node npm npx python3 docker sha256sum; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
BENCHMARK_ID="cc-main-2026-30-${TIMESTAMP}-standard1-benchmark-${NONCE}"
WORKER_NAME="growthsent-standard1-bm-${NONCE}"
BUNDLE_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-${BENCHMARK_ID}-XXXXXX")"
BUNDLE_DIRECTORY="$BUNDLE_ROOT/bundle"

echo "GrowthSent Cloudflare standard-1 one-WAT remote benchmark (Ubuntu/WSL native)"
echo "Benchmark ID: $BENCHMARK_ID"
echo "R2 prefix: production/common-crawl/cloudflare-r2-standard1-benchmarks/v1/$BENCHMARK_ID/"
echo "Reference baseline SHA-256: $(sha256sum "$REFERENCE_MANIFEST" | awk '{print $1}')"
echo "Scope: exactly one selected baseline WAT, one temporary Worker/Container, one HTTPS stream, 110-minute hard timeout."
echo "The Worker receives only a two-hour child credential restricted to this new benchmark prefix; the parent secret is never installed remotely."
read -r -p "Press Enter to continue: " _

python3 "$SCRIPT_DIR/build_bundle.py" \
  --benchmark-id "$BENCHMARK_ID" \
  --worker-name "$WORKER_NAME" \
  --container-name "$WORKER_NAME" \
  --reference-manifest "$REFERENCE_MANIFEST" \
  --reference-baseline-key "$REFERENCE_BASELINE_KEY" \
  --output-dir "$BUNDLE_DIRECTORY"
npm --prefix "$BUNDLE_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
BOTO3_SITE_PACKAGES="$BUNDLE_DIRECTORY/.boto3-preflight-packages"
python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --quiet --target "$BOTO3_SITE_PACKAGES" "boto3==1.43.67"

read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_BOTO3_SITE_PACKAGES="$BOTO3_SITE_PACKAGES" node "$BUNDLE_DIRECTORY/provision-and-start-wsl.mjs" --approved-one-wat-standard1-benchmark "$BUNDLE_DIRECTORY"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Standard-1 benchmark provisioner failed. No retry was attempted." >&2
  exit "$RESULT"
fi
echo "Bundle context (no secrets): $BUNDLE_DIRECTORY/BENCHMARK-CONTEXT.json"
