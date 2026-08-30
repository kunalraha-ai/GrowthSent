#!/usr/bin/env bash
# Read-only post-run verifier for one standard-1 one-WAT benchmark.
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--benchmark-id" ]] || ! [[ "$2" =~ ^cc-main-2026-30-[a-z0-9-]+$ ]]; then
  echo "Usage: $0 --benchmark-id <cc-main-2026-30-benchmark-id>" >&2
  exit 2
fi

BENCHMARK_ID="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-}"
REFERENCE_BASELINE_KEY="${GROWTHSENT_REFERENCE_BASELINE_KEY:-}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -n "$REFERENCE_MANIFEST" && -f "$REFERENCE_MANIFEST" ]] || { echo "Set GROWTHSENT_REFERENCE_MANIFEST to the reviewed local baseline manifest." >&2; exit 1; }
[[ "$REFERENCE_BASELINE_KEY" =~ ^production/common-crawl/audit/public-source-baseline/v2/[a-z0-9][a-z0-9-]{0,63}/PUBLIC-SOURCE-BASELINE-MANIFEST\.json$ ]] || { echo "Set GROWTHSENT_REFERENCE_BASELINE_KEY to the exact published baseline key." >&2; exit 1; }
[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" ]] || { echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2; exit 1; }
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REFERENCE_SHA256="$(sha256sum "$REFERENCE_MANIFEST" | awk '{print $1}')"
[[ "$REFERENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "The local baseline SHA-256 is invalid." >&2; exit 1; }

VERIFY_DIRECTORY="$(mktemp -d -t "growthsent-cloudflare-standard1-verify-${BENCHMARK_ID}-XXXXXX")"
cp "$SCRIPT_DIR/verify-benchmark-wsl.mjs" "$VERIFY_DIRECTORY/verify-benchmark-wsl.mjs"
npm --prefix "$VERIFY_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund aws4fetch@1.0.20 >/dev/null

echo "GrowthSent standard-1 one-WAT benchmark read-only verification (Ubuntu/WSL native)"
echo "Benchmark ID: $BENCHMARK_ID"
echo "Scope: read-only metadata and JSON verification for this benchmark prefix and its selected public-source baseline."
read -r -p "Press Enter to continue: " _
read -r -s -p "Paste the short-lived parent Cloudflare API token: " PARENT_TOKEN
printf '\n'
[[ -n "$PARENT_TOKEN" ]] || { echo "A parent Cloudflare API token is required." >&2; exit 1; }
set +e
printf '%s' "$PARENT_TOKEN" | GROWTHSENT_REFERENCE_BASELINE_KEY="$REFERENCE_BASELINE_KEY" GROWTHSENT_REFERENCE_MANIFEST_SHA256="$REFERENCE_SHA256" node "$VERIFY_DIRECTORY/verify-benchmark-wsl.mjs" "$BENCHMARK_ID" "$VERIFY_DIRECTORY"
RESULT=$?
unset PARENT_TOKEN
set -e
if [[ $RESULT -ne 0 ]]; then
  echo "Read-only standard-1 benchmark verification did not pass. No Worker, Container, or R2 object was changed." >&2
  exit "$RESULT"
fi
echo "Local, secret-free verification report: $VERIFY_DIRECTORY/VERIFICATION-REPORT.json"
