#!/usr/bin/env bash
# Bounded, one-time compaction canary for the already-complete v1 Links corpus.
#
# This script has no WAT ingestion path and never writes beneath a raw output
# prefix.  It reads exactly 1,000 v1 Links Parquet objects, produces a new
# 1,024-bucket target_host layout locally, and publishes only to the isolated
# canary prefix after the build and verification reports are complete.
set -Eeuo pipefail

readonly RUN_ID="cc-main-2026-30-first-1000-derived-canary"
readonly CRAWL="CC-MAIN-2026-30"
readonly BUCKET="growthsent-data-552648196041-us-east-1-an"
readonly SOURCE_PREFIX="production/common-crawl/wat-pages-links/v1/cc-main-2026-30-first-1000/crawl=CC-MAIN-2026-30/dataset=links/"
readonly DESTINATION_PREFIX="production/common-crawl/backlink-derived-canary/v1/cc-main-2026-30-first-1000/"
readonly EXPECTED_LINK_FILES=1000
readonly EXPECTED_INPUT_BYTES=79181489365
readonly ROOT="/opt/growthsent-backlink-derived-canary"
readonly INPUT_DIR="$ROOT/input-links"
readonly OUTPUT_ROOT="$ROOT/output"
readonly STATUS_DIR="$ROOT/status"
readonly DETAIL_ROOT="$OUTPUT_ROOT/crawl=$CRAWL/dataset=backlink-details"
readonly PYTHON="$ROOT/venv/bin/python"
readonly TOOL="$ROOT/release/tools/common_crawl_backlink_derive.py"

mkdir -p "$INPUT_DIR" "$OUTPUT_ROOT" "$STATUS_DIR" "$ROOT/duckdb-spill"
exec > >(tee -a "$STATUS_DIR/production.log") 2>&1

write_status() {
  local phase="$1"
  "$PYTHON" - "$STATUS_DIR/status.json" "$phase" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, phase = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"run_id": "cc-main-2026-30-first-1000-derived-canary", "phase": phase,
               "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}, handle,
              sort_keys=True)
    handle.write("\n")
PY
}

fail() {
  local code="$?"
  write_status "failed"
  echo "CANARY_FAILED exit_code=$code command=${BASH_COMMAND}" >&2
  exit "$code"
}
trap fail ERR

verify_destination_is_empty() {
  if aws s3api head-object --bucket "$BUCKET" --key "${DESTINATION_PREFIX}CANARY-COMPLETED.json" >/dev/null 2>&1; then
    echo "refusing to overwrite a completed canary prefix: s3://$BUCKET/$DESTINATION_PREFIX" >&2
    exit 2
  fi
}

sum_local_input_bytes() {
  find "$INPUT_DIR" -type f -name '*.parquet' -printf '%s\n' | awk '{total += $1} END {printf "%.0f\n", total}'
}

write_metrics() {
  "$PYTHON" - "$OUTPUT_ROOT/crawl=$CRAWL/dataset=backlink-details/DERIVED-MANIFEST.json" \
    "$STATUS_DIR/derive-time.txt" "$STATUS_DIR/disk-samples.tsv" "$STATUS_DIR/DERIVED-CANARY-METRICS.json" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

manifest_path, time_path, disk_path, metrics_path = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
time_text = time_path.read_text(encoding="utf-8", errors="replace")
match = re.search(r"Maximum resident set size \(kbytes\): (\d+)", time_text)
max_rss_kib = int(match.group(1)) if match else None
samples = []
for line in disk_path.read_text(encoding="utf-8", errors="replace").splitlines():
    parts = line.split("\t")
    if len(parts) == 2 and parts[1].isdigit():
        samples.append(int(parts[1]))
files = manifest["detail_files"]
buckets = []
for entry in files:
    match = re.search(r"target_host_bucket=(\d{4})", entry["path"])
    if match:
        buckets.append({"bucket": match.group(1), "bytes": entry["bytes"], "rows": entry["rows"]})
buckets.sort(key=lambda item: (item["bytes"], item["bucket"]))
metrics = {
    "format_version": 1,
    "kind": "common-crawl-backlink-derived-canary-metrics",
    "run_id": manifest["run_id"],
    "crawl": manifest["crawl"],
    "source": {
        "links_file_count": len(manifest["source_links"]["files"]),
        "input_bytes": sum(item["bytes"] for item in manifest["source_links"]["files"]),
        "rows_read": sum(item["rows"] for item in manifest["source_links"]["files"]),
        "source_fingerprint_sha256": manifest["source_links"]["fingerprint_sha256"],
    },
    "detail": {
        "bucket_count": manifest["bucket_count"], "files_created": len(files),
        "rows_emitted": manifest["detail_rows"], "output_bytes": manifest["detail_bytes"],
        "build_seconds": manifest["build_seconds"], "max_rss_kib": max_rss_kib,
        "peak_used_bytes_on_worker_volume": max(samples) if samples else None,
        "smallest_bucket": buckets[0] if buckets else None,
        "largest_bucket": buckets[-1] if buckets else None,
        "bucket_bytes_p50": buckets[len(buckets) // 2]["bytes"] if buckets else None,
        "bucket_rows_p50": sorted(item["rows"] for item in buckets)[len(buckets) // 2] if buckets else None,
    },
    "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
metrics_path.write_text(json.dumps(metrics, sort_keys=True, indent=2) + "\n", encoding="utf-8")
PY
}

build_rollup_if_present() {
  local host="$1"
  local report="$STATUS_DIR/rollup-${host}.json"
  local error="$STATUS_DIR/rollup-${host}.err"
  if "$PYTHON" "$TOOL" build-host-rollup \
    --detail-root "$DETAIL_ROOT" --output-root "$OUTPUT_ROOT" --run-id "$RUN_ID" --crawl "$CRAWL" \
    --target-host "$host" --top-k 100 --memory-limit 8GB --threads 2 >"$report" 2>"$error"; then
    echo "ROLLUP_BUILT host=$host"
    return 0
  fi
  if grep -Fq "target host was not found in its deterministic detail bucket" "$error"; then
    "$PYTHON" - "$report" "$host" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"target_host": sys.argv[2], "outcome": "not_present"}, sort_keys=True) + "\n", encoding="utf-8")
PY
    echo "ROLLUP_NOT_PRESENT host=$host"
    return 0
  fi
  cat "$error" >&2
  return 1
}

write_status "starting"
test -x "$PYTHON"
test -f "$TOOL"
verify_destination_is_empty

write_status "syncing_v1_links_read_only"
aws s3 sync --only-show-errors --no-progress "s3://$BUCKET/$SOURCE_PREFIX" "$INPUT_DIR/"
local_file_count="$(find "$INPUT_DIR" -type f -name '*.parquet' | wc -l | tr -d '[:space:]')"
local_input_bytes="$(sum_local_input_bytes)"
test "$local_file_count" -eq "$EXPECTED_LINK_FILES"
test "$local_input_bytes" -eq "$EXPECTED_INPUT_BYTES"

write_status "building_1024_target_host_buckets"
(
  while true; do
    used="$(du -sb "$ROOT" | awk '{print $1}')"
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$used" >> "$STATUS_DIR/disk-samples.tsv"
    sleep 15
  done
) &
monitor_pid="$!"
set +e
/usr/bin/time -v "$PYTHON" "$TOOL" build-detail-shard \
  --links-dir "$INPUT_DIR" --output-root "$OUTPUT_ROOT" --run-id "$RUN_ID" --crawl "$CRAWL" \
  --shard-id 0 --shard-count 1 --expected-links-files "$EXPECTED_LINK_FILES" \
  --memory-limit 24GB --threads 4 --row-group-size 50000 --temp-directory "$ROOT/duckdb-spill" \
  >"$STATUS_DIR/detail-report.json" 2>"$STATUS_DIR/derive-time.txt"
derive_status="$?"
set -e
kill "$monitor_pid" 2>/dev/null || true
wait "$monitor_pid" 2>/dev/null || true
test "$derive_status" -eq 0

write_status "building_bounded_host_rollups"
build_rollup_if_present "github.com"
build_rollup_if_present "mongodb.com"
build_rollup_if_present "eignex.com"
extra_host="$($PYTHON - "$DETAIL_ROOT" <<'PY'
import sys
from pathlib import Path
import duckdb

root = Path(sys.argv[1])
first = next(iter(sorted(root.rglob('*.parquet'))))
row = duckdb.connect(':memory:').execute(
    "SELECT target_host FROM read_parquet(?) WHERE target_host NOT IN ('github.com', 'mongodb.com', 'eignex.com') LIMIT 1",
    [[first.as_posix()]],
).fetchone()
if row is None:
    raise SystemExit('could not choose an additional target host from first detail bucket')
print(row[0])
PY
)"
build_rollup_if_present "$extra_host"
printf '%s\n' "$extra_host" > "$STATUS_DIR/additional-known-target-host.txt"

write_metrics
write_status "publishing_new_canary_prefix"
# Only completed, immutable local output roots are copied.  The marker is
# deliberately uploaded last; a Data Federation mapping is not created until
# this marker and the manifest have both been checked.
aws s3 sync --only-show-errors --no-progress "$OUTPUT_ROOT/crawl=$CRAWL/" "s3://$BUCKET/$DESTINATION_PREFIX/crawl=$CRAWL/"
aws s3 cp --only-show-errors "$STATUS_DIR/DERIVED-CANARY-METRICS.json" "s3://$BUCKET/$DESTINATION_PREFIX/metrics/DERIVED-CANARY-METRICS.json"
aws s3 cp --only-show-errors "$STATUS_DIR/detail-report.json" "s3://$BUCKET/$DESTINATION_PREFIX/metrics/detail-report.json"
aws s3 cp --only-show-errors "$STATUS_DIR/derive-time.txt" "s3://$BUCKET/$DESTINATION_PREFIX/logs/derive-time.txt"
for report in "$STATUS_DIR"/rollup-*.json; do
  test -e "$report" || continue
  aws s3 cp --only-show-errors "$report" "s3://$BUCKET/$DESTINATION_PREFIX/metrics/$(basename "$report")"
done
"$PYTHON" - "$STATUS_DIR/CANARY-COMPLETED.json" "$STATUS_DIR/DERIVED-CANARY-METRICS.json" <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

output, metrics = map(Path, sys.argv[1:])
payload = json.loads(metrics.read_text(encoding="utf-8"))
output.write_text(json.dumps({
    "format_version": 1,
    "kind": "common-crawl-backlink-derived-canary-completion",
    "run_id": payload["run_id"],
    "crawl": payload["crawl"],
    "metrics_sha256": hashlib.sha256(metrics.read_bytes()).hexdigest(),
    "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
PY
aws s3 cp --only-show-errors "$STATUS_DIR/CANARY-COMPLETED.json" "s3://$BUCKET/$DESTINATION_PREFIX/CANARY-COMPLETED.json"
write_status "completed"
echo "CANARY_COMPLETED run_id=$RUN_ID additional_host=$extra_host"
