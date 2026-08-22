#!/usr/bin/env bash
# Locked 10K derived-backlink v1 worker.  It never invokes WAT ingestion.
set -Eeuo pipefail

readonly RUN_ID_EXPECTED="cc-main-2026-30-first-10000"
readonly CRAWL="CC-MAIN-2026-30"
readonly SHARD_COUNT_EXPECTED=10
readonly BUCKET="growthsent-data-552648196041-us-east-1-an"
readonly RAW_LINKS_PREFIX="production/common-crawl/wat-pages-links/v2/cc-main-2026-30-first-10000/crawl=CC-MAIN-2026-30/dataset=links"
readonly DERIVED_PREFIX="production/common-crawl/backlink-derived/v1/cc-main-2026-30-first-10000"
readonly IDENTITY_FILE="/etc/growthsent/common-crawl-backlink-derived-v1/launch-identity.env"

[[ -s "$IDENTITY_FILE" ]] || { echo "missing derive launch identity" >&2; exit 2; }
set -a; source "$IDENTITY_FILE"; set +a
[[ "${RUN_ID:-}" == "$RUN_ID_EXPECTED" ]] || { echo "unexpected derive RunId" >&2; exit 2; }
[[ "${DERIVE_SHARD_COUNT:-}" == "$SHARD_COUNT_EXPECTED" ]] || { echo "unexpected derive shard count" >&2; exit 2; }
[[ "${DERIVE_SHARD_ID:-}" =~ ^[0-9]+$ ]] && (( DERIVE_SHARD_ID >= 0 && DERIVE_SHARD_ID < SHARD_COUNT_EXPECTED )) || { echo "unexpected derive shard id" >&2; exit 2; }

readonly LABEL="$(printf 'shard-%03d-of-%03d' "$DERIVE_SHARD_ID" "$DERIVE_SHARD_COUNT")"
readonly RELEASE="${RELEASE:?RELEASE must name the reviewed SHA release directory}"
readonly PYTHON="${PYTHON:-/opt/growthsent/venv/bin/python}"
readonly ROOT="${DERIVE_ROOT:-/opt/growthsent-backlink-derived-v1/$RUN_ID/$LABEL}"
readonly INPUT_DIR="$ROOT/input-links"
readonly OUTPUT_ROOT="$ROOT/output"
readonly STATUS_DIR="$ROOT/status"
readonly SPILL_DIR="$ROOT/duckdb-spill"
readonly TOOL="$RELEASE/tools/common_crawl_backlink_derive.py"
readonly PROTOCOL="$RELEASE/tools/common_crawl_backlink_derive_production_v1.py"
readonly BASE_MANIFEST="$RELEASE/manifests/base-manifest.json"
readonly SHARD_MANIFEST="$RELEASE/manifests/shards/$(printf 'shard-%05d-of-%05d.json' "$DERIVE_SHARD_ID" "$DERIVE_SHARD_COUNT")"
readonly SHARD_PLAN="$RELEASE/manifests/shards/shard-plan.json"
readonly SOURCE_PLAN="$STATUS_DIR/source-plan.json"
readonly DETAIL_ROOT="$OUTPUT_ROOT/crawl=$CRAWL/dataset=backlink-details"
readonly DETAIL_SHARD_ROOT="$DETAIL_ROOT/input_shard=$LABEL"
readonly LOG_FILE="$STATUS_DIR/production-derive.log"
export PYTHONPATH="$RELEASE/tools${PYTHONPATH:+:$PYTHONPATH}"

mkdir -p "$INPUT_DIR" "$OUTPUT_ROOT" "$STATUS_DIR" "$SPILL_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

write_status() {
  "$PYTHON" - "$STATUS_DIR/status.json" "$1" "$DERIVE_SHARD_ID" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"run_id": "cc-main-2026-30-first-10000", "phase": sys.argv[2], "shard_id": int(sys.argv[3]), "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}, sort_keys=True) + "\n", encoding="utf-8")
PY
}
trap 'write_status failed; echo "DERIVE_FAILED command=${BASH_COMMAND}" >&2' ERR

write_status validating_contract
test -x "$PYTHON"; test -f "$TOOL"; test -f "$PROTOCOL"
"$PYTHON" "$PROTOCOL" write-source-plan --base-manifest "$BASE_MANIFEST" --shard-manifest "$SHARD_MANIFEST" --shard-plan "$SHARD_PLAN" --shard-id "$DERIVE_SHARD_ID" --shard-count "$DERIVE_SHARD_COUNT" --output "$SOURCE_PLAN"

write_status syncing_exact_raw_links
mapfile -t source_entries < <("$PYTHON" - "$SOURCE_PLAN" <<'PY'
import json, sys
for entry in json.load(open(sys.argv[1], encoding="utf-8"))["entries"]:
    print(entry["key"] + "\t" + entry["suffix"])
PY
)
test "${#source_entries[@]}" -eq 1000
for entry in "${source_entries[@]}"; do
  key="${entry%%$'\t'*}"; suffix="${entry##*$'\t'}"
  aws s3 cp --only-show-errors "s3://$BUCKET/$key" "$INPUT_DIR/part-$suffix.parquet"
done
test "$(find "$INPUT_DIR" -maxdepth 1 -type f -name 'part-*.parquet' | wc -l | tr -d '[:space:]')" -eq 1000

write_status building_1024_target_host_buckets
"$PYTHON" "$TOOL" build-detail-shard --links-dir "$INPUT_DIR" --output-root "$OUTPUT_ROOT" --run-id "$RUN_ID" --crawl "$CRAWL" --shard-id "$DERIVE_SHARD_ID" --shard-count "$DERIVE_SHARD_COUNT" --expected-links-files 1000 --memory-limit 24GB --threads 4 --row-group-size 50000 --temp-directory "$SPILL_DIR" --max-temp-directory-size 1.25TiB --resume > "$STATUS_DIR/detail-report.json"
"$PYTHON" "$PROTOCOL" verify-local-detail --base-manifest "$BASE_MANIFEST" --shard-manifest "$SHARD_MANIFEST" --shard-plan "$SHARD_PLAN" --shard-id "$DERIVE_SHARD_ID" --shard-count "$DERIVE_SHARD_COUNT" --output-root "$OUTPUT_ROOT" > "$STATUS_DIR/detail-verification.json"

write_status building_bounded_host_rollups
while IFS= read -r host; do
  [[ -z "$host" || "$host" == \#* ]] && continue
  rollup_identity="$("$PYTHON" - "$host" "$DERIVE_SHARD_ID" <<'PY'
import hashlib, sys
from common_crawl_backlink_derive import host_bucket
print(f"input_shard=shard-{int(sys.argv[2]):03d}-of-010/target_host_bucket={host_bucket(sys.argv[1])}/target_host_key={hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16]}")
PY
)"
  if test -f "$OUTPUT_ROOT/crawl=$CRAWL/dataset=backlink-host-rollups/$rollup_identity/DERIVED-MANIFEST.json"; then
    printf '{"target_host":"%s","outcome":"already_verified"}\n' "$host" > "$STATUS_DIR/rollup-$host.json"
  elif "$PYTHON" "$TOOL" build-host-rollup --detail-root "$DETAIL_ROOT" --output-root "$OUTPUT_ROOT" --run-id "$RUN_ID" --crawl "$CRAWL" --target-host "$host" --top-k 100 --memory-limit 8GB --threads 2 --input-shard-id "$DERIVE_SHARD_ID" --input-shard-count "$DERIVE_SHARD_COUNT" > "$STATUS_DIR/rollup-$host.json" 2> "$STATUS_DIR/rollup-$host.err"; then
    :
  elif grep -Fq 'target host was not found in its deterministic detail bucket' "$STATUS_DIR/rollup-$host.err"; then
    printf '{"target_host":"%s","outcome":"not_present"}\n' "$host" > "$STATUS_DIR/rollup-$host.json"
  else
    cat "$STATUS_DIR/rollup-$host.err" >&2; exit 1
  fi
done < "$RELEASE/config/derive-rollup-hosts.txt"

write_status preparing_publication
"$PYTHON" - "$STATUS_DIR/DERIVED-SHARD-METRICS.json" "$STATUS_DIR/detail-report.json" "$SOURCE_PLAN" <<'PY'
import json, sys
from datetime import datetime, timezone
out, report, source = map(str, sys.argv[1:])
json.dump({"format_version": 1, "kind": "growthsent-derived-v1-shard-metrics", "run_id": "cc-main-2026-30-first-10000", "shard_id": int(__import__('os').environ['DERIVE_SHARD_ID']), "detail": json.load(open(report)), "source_plan_sha256": json.load(open(source))["source_plan_sha256"], "generated_at": datetime.now(timezone.utc).isoformat().replace('+00:00','Z')}, open(out, 'w'), sort_keys=True)
PY
write_status publishing_verified_shard
"$PYTHON" "$PROTOCOL" publish --base-manifest "$BASE_MANIFEST" --shard-manifest "$SHARD_MANIFEST" --shard-plan "$SHARD_PLAN" --shard-id "$DERIVE_SHARD_ID" --shard-count "$DERIVE_SHARD_COUNT" --output-root "$OUTPUT_ROOT" --status-dir "$STATUS_DIR" --owner "$(hostname)" > "$STATUS_DIR/publication-report.json"
write_status completed
echo "DERIVE_SHARD_COMPLETED shard=$DERIVE_SHARD_ID label=$LABEL detail_root=$DETAIL_SHARD_ROOT"
