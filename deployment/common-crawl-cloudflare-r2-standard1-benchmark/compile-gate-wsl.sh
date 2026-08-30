#!/usr/bin/env bash
# Build and compile-gate a standard-1, one-WAT Container benchmark locally.
# This script has no Cloudflare API, R2, Worker deployment, or Container start.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-/mnt/c/Users/kunal/AppData/Local/Temp/growthsent-cloudflare-10-wat-reference-v2/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"
WSL_NODE_BIN="${GROWTHSENT_WSL_NODE_BIN:-$HOME/.local/share/growthsent-tools/node-v22.23.2-linux-x64/bin}"

[[ -x "$WSL_NODE_BIN/node" && -x "$WSL_NODE_BIN/npm" && -x "$WSL_NODE_BIN/npx" ]] || {
  echo "The reviewed native Ubuntu Node runtime is unavailable: $WSL_NODE_BIN" >&2
  exit 1
}
export PATH="$WSL_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for command in node npm npx python3 docker sha256sum; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done
[[ -f "$REFERENCE_MANIFEST" ]] || { echo "Missing reviewed public-source semantic baseline v2: $REFERENCE_MANIFEST" >&2; exit 1; }
docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }
REFERENCE_SHA256="$(sha256sum "$REFERENCE_MANIFEST" | awk '{print $1}')"

NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')"
BENCHMARK_ID="${GROWTHSENT_BENCHMARK_ID:-cc-main-2026-30-${TIMESTAMP}-standard1-benchmark-${NONCE}}"
WORKER_NAME="${GROWTHSENT_WORKER_NAME:-growthsent-standard1-bm-${NONCE}}"
BUNDLE_ROOT="$(mktemp -d -t "growthsent-cloudflare-standard1-${BENCHMARK_ID}-XXXXXX")"
BUNDLE_DIRECTORY="$BUNDLE_ROOT/bundle"

[[ "$BENCHMARK_ID" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "The benchmark ID must be a lowercase slug of at most 64 characters." >&2; exit 1; }
[[ "$WORKER_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "The Worker name must be a lowercase slug of at most 63 characters." >&2; exit 1; }

echo "GrowthSent Cloudflare standard-1 one-WAT benchmark compilation gate (Ubuntu/WSL native)"
echo "Benchmark ID: $BENCHMARK_ID"
echo "Candidate R2 prefix for a later approved remote run: production/common-crawl/cloudflare-r2-standard1-benchmarks/v1/$BENCHMARK_ID/"
echo "Reference baseline SHA-256: $REFERENCE_SHA256"
echo "Scope: local bundle build, local Docker image build, Wrangler config check, and Wrangler --dry-run only."
echo "No Cloudflare API call, R2 object, Worker deployment, Container start, or credential mint occurs."
if [[ "${GROWTHSENT_NONINTERACTIVE:-}" != "1" ]]; then
  read -r -p "Press Enter to continue: " _
fi

python3 "$SCRIPT_DIR/build_bundle.py" \
  --benchmark-id "$BENCHMARK_ID" \
  --worker-name "$WORKER_NAME" \
  --container-name "$WORKER_NAME" \
  --reference-manifest "$REFERENCE_MANIFEST" \
  --output-dir "$BUNDLE_DIRECTORY"
npm --prefix "$BUNDLE_DIRECTORY" install --no-package-lock --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null
python3 - "$BUNDLE_DIRECTORY/wrangler.jsonc" <<'PY'
import json
import sys
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
container = config.get("containers", [None])[0]
binding = config.get("durable_objects", {}).get("bindings", [None])[0]
assert container == {
    "class_name": "GrowthSentStandard1BenchmarkContainer",
    "image": "./Dockerfile",
    "instance_type": "standard-1",
    "max_instances": 1,
    "name": config["name"],
}
assert binding == {
    "class_name": "GrowthSentStandard1BenchmarkContainer",
    "name": "BENCHMARK_CONTAINER",
}
assert config.get("vars", {}).get("GROWTHSENT_CONTAINER_INSTANCE_TYPE") == "standard-1"
PY
(
  cd "$BUNDLE_DIRECTORY"
  npx --offline --yes wrangler@4.126.0 deploy --dry-run --config wrangler.jsonc
)
docker run --rm --entrypoint python "$WORKER_NAME:worker" -c "
import json
from pathlib import Path
import common_crawl_cloudflare_r2_standard1_benchmark as benchmark
manifest_path = Path('/opt/growthsent/reference-manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
expected = manifest['entries'][benchmark.REFERENCE_ENTRY_INDEX]
entry = benchmark.selected_reference_entry(manifest_path, expected_sha256='$REFERENCE_SHA256')
assert entry.source_key == expected['source_key']
assert entry.deterministic_suffix == expected['deterministic_suffix']
assert benchmark.INPUT_COUNT == 1 and benchmark.REFERENCE_ENTRY_INDEX == 0
print('standard-1 benchmark runtime reference gate passed')
"

python3 - "$BUNDLE_DIRECTORY" "$BENCHMARK_ID" "$WORKER_NAME" <<'PY'
import json
import sys
from pathlib import Path

bundle = Path(sys.argv[1])
context = {
    "benchmark_id": sys.argv[2],
    "worker_name": sys.argv[3],
    "mode": "local-compilation-gate",
    "remote_start_permitted": False,
    "r2_write_attempted": False,
    "worker_deployed": False,
    "container_started": False,
    "instance_type": "standard-1",
    "input_count": 1,
    "reference_manifest_entry_count": 10,
}
(bundle / "BENCHMARK-CONTEXT.json").write_text(json.dumps(context, indent=2) + "\n", encoding="utf-8")
PY

echo "SUCCESS: standard-1 one-WAT benchmark bundle compiled locally."
echo "Secret-free context: $BUNDLE_DIRECTORY/BENCHMARK-CONTEXT.json"
echo "Remote deployment and start remain disabled until separately approved."
