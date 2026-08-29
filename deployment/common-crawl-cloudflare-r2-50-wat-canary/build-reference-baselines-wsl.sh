#!/usr/bin/env bash
# Build four new local, immutable-input public-source semantic v2 baselines
# for the bounded 50-WAT Cloudflare fan-out canary. Shard 1 reuses the already
# verified ten-WAT baseline. This script never talks to R2 and never starts a
# Worker or Container.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
BASELINE_BUILDER="$ROOT/tools/build_common_crawl_public_baseline_v2.py"
REFERENCE_DIR="${GROWTHSENT_50_REFERENCE_DIR:-$(mktemp -d -t growthsent-cloudflare-50-wat-reference-XXXXXX)}"
SHARD_ONE_REFERENCE_MANIFEST="${GROWTHSENT_REFERENCE_MANIFEST:-/mnt/c/Users/kunal/AppData/Local/Temp/growthsent-cloudflare-10-wat-reference-v2/PUBLIC-SOURCE-BASELINE-MANIFEST.json}"
BUNDLE_ROOT=""
BASELINE_IMAGE=""
USE_DOCKER=0

cleanup() {
  if [[ -n "$BASELINE_IMAGE" ]]; then
    docker image rm "$BASELINE_IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BUNDLE_ROOT" && -d "$BUNDLE_ROOT" ]]; then
    rm -rf -- "$BUNDLE_ROOT"
  fi
}
trap cleanup EXIT

[[ -f "$BASELINE_BUILDER" ]] || { echo "Missing baseline builder: $BASELINE_BUILDER" >&2; exit 1; }
[[ -f "$SHARD_ONE_REFERENCE_MANIFEST" ]] || { echo "Missing verified shard-1 reference baseline: $SHARD_ONE_REFERENCE_MANIFEST" >&2; exit 1; }
for command in python3 sha256sum; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required Ubuntu command: $command" >&2; exit 1; }
done

if [[ -n "${GROWTHSENT_50_REFERENCE_DIR:-}" ]]; then
  [[ ! -e "$REFERENCE_DIR" ]] || { echo "Refusing to reuse existing reference directory: $REFERENCE_DIR" >&2; exit 1; }
  mkdir -p "$REFERENCE_DIR"
fi

echo "GrowthSent 50-WAT public-source reference preparation (Ubuntu/WSL native)"
echo "Scope: one verified baseline reuse plus four distinct ten-WAT public-HTTPS local baselines."
echo "Destination: $REFERENCE_DIR"
echo "No R2 object, Worker, or Container will be created."
read -r -p "Press Enter to continue: " _

# The user's native Ubuntu Python may not include pyarrow. When that happens,
# use the exact pinned dependency image from the reviewed Container bundle.
# The Docker process runs as the invoking WSL user and mounts only source tools,
# locked input JSON, and this ephemeral local reference directory.
if ! python3 -c 'import pyarrow.parquet' >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { echo "Ubuntu Python lacks pyarrow and Docker is unavailable." >&2; exit 1; }
  docker version >/dev/null 2>&1 || { echo "Docker Engine is not reachable from Ubuntu WSL." >&2; exit 1; }
  BUNDLE_ROOT="$(mktemp -d -t growthsent-cloudflare-50-wat-baseline-image-XXXXXX)"
  BUNDLE_DIRECTORY="$BUNDLE_ROOT/bundle"
  BUILD_NONCE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  python3 "$ROOT/deployment/common-crawl-cloudflare-r2-10-wat-canary/build_bundle.py" \
    --run-id "cc-main-2026-30-50-ref-$BUILD_NONCE" \
    --worker-name "growthsent-50ref-$BUILD_NONCE" \
    --container-name "growthsent-50ref-$BUILD_NONCE" \
    --reference-manifest "$SHARD_ONE_REFERENCE_MANIFEST" \
    --output-dir "$BUNDLE_DIRECTORY"
  BASELINE_IMAGE="growthsent-50-wat-reference-$BUILD_NONCE"
  docker build --tag "$BASELINE_IMAGE" "$BUNDLE_DIRECTORY"
  USE_DOCKER=1
  echo "Using the reviewed Docker dependency image because native Ubuntu Python has no pyarrow."
fi

run_baseline_builder() {
  local input_spec="$1"
  local manifest="$2"
  local work_dir="$3"
  if [[ "$USE_DOCKER" == "1" ]]; then
    docker run --rm --user "$(id -u):$(id -g)" \
      --volume "$ROOT/tools:/opt/growthsent/tools:ro" \
      --volume "$SCRIPT_DIR:/inputs:ro" \
      --volume "$REFERENCE_DIR:/reference" \
      --entrypoint python \
      "$BASELINE_IMAGE" \
      /opt/growthsent/tools/build_common_crawl_public_baseline_v2.py \
      --input-spec "/inputs/$(basename "$input_spec")" \
      --output-manifest "/reference/${manifest#"$REFERENCE_DIR/"}" \
      --work-dir "/reference/${work_dir#"$REFERENCE_DIR/"}"
  else
    python3 "$BASELINE_BUILDER" \
      --input-spec "$input_spec" \
      --output-manifest "$manifest" \
      --work-dir "$work_dir"
  fi
}

mkdir -p "$REFERENCE_DIR/shard-01"
cp "$SHARD_ONE_REFERENCE_MANIFEST" "$REFERENCE_DIR/shard-01/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
printf '{"stage":"shard_baseline_reused","shard":1,"manifest":"%s","sha256":"%s"}\n' \
  "$REFERENCE_DIR/shard-01/PUBLIC-SOURCE-BASELINE-MANIFEST.json" \
  "$(sha256sum "$REFERENCE_DIR/shard-01/PUBLIC-SOURCE-BASELINE-MANIFEST.json" | awk '{print $1}')"

for shard in 02 03 04 05; do
  input_spec="$SCRIPT_DIR/cc-main-2026-30-shard-${shard}-inputs.v2.json"
  manifest="$REFERENCE_DIR/shard-${shard}/PUBLIC-SOURCE-BASELINE-MANIFEST.json"
  work_dir="$REFERENCE_DIR/work-${shard}"
  [[ -f "$input_spec" ]] || { echo "Missing locked shard input: $input_spec" >&2; exit 1; }
  run_baseline_builder "$input_spec" "$manifest" "$work_dir"
  [[ ! -e "$work_dir" ]] || { echo "Baseline builder left a work directory: $work_dir" >&2; exit 1; }
  printf '{"stage":"shard_baseline_ready","shard":%s,"manifest":"%s","sha256":"%s"}\n' \
    "$((10#$shard))" "$manifest" "$(sha256sum "$manifest" | awk '{print $1}')"
done

echo "SUCCESS: five local public-source baselines are ready (one reused, four newly built)."
echo "Reference directory (no secrets): $REFERENCE_DIR"
