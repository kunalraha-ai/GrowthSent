# Common Crawl WAT ingestion

`tools/common_crawl_wat_ingest.py` converts Common Crawl WAT files directly to
Snappy-compressed Parquet. It has no MongoDB import or deployment path.

For the local acceptance sample:

```powershell
python tools/common_crawl_wat_ingest.py `
  --crawl CC-MAIN-2026-30 `
  --input sample.warc.wat.gz `
  --output-dir artifacts/common-crawl
```

For a listed Common Crawl object key, install
`requirements-common-crawl.txt` and pass the key directly (the default source
bucket is `commoncrawl`):

```powershell
python tools/common_crawl_wat_ingest.py `
  --crawl CC-MAIN-2026-30 `
  --input crawl-data/CC-MAIN-2026-30/segments/.../wat/CC-MAIN-....warc.wat.gz `
  --resume
```

The command writes deterministic parts under:

```text
<output-dir>/crawl=<crawl>/dataset=pages/part-<input-hash>.parquet
<output-dir>/crawl=<crawl>/dataset=links/part-<input-hash>.parquet
```

Each successful part has a JSON metrics sidecar. `--resume` reuses completed
local parts. Failed or interrupted parts remain `.tmp` files and are rebuilt.
Use `--workers 1`, `--workers 2`, `--workers 4`, or `--workers 8` to process
independent inputs in separate processes. Every source owns a deterministic
pair of output parts, so workers never write the same Parquet file. Aggregate
metrics report both elapsed wall time and summed worker time. Per-worker memory
is still bounded by `--batch-size`; total process memory scales with workers.
When there are fewer inputs than requested workers, the pool is capped at the
number of inputs.

## Cloud benchmark safety

Use a finite prefix of a path list, fixed-size file batches, and explicit S3
publication. `--resume --upload` checks the deterministic remote pages, links,
and metrics objects before work starts; it downloads the metrics sidecar only
when all three are present, then skips that input. This makes an interrupted
cloud benchmark safe to restart without duplicate parts.

```powershell
python tools/common_crawl_wat_ingest.py `
  --crawl CC-MAIN-2026-30 `
  --input-list wat.paths.gz `
  --max-inputs 100 `
  --workers 4 `
  --files-per-batch 16 `
  --resume `
  --upload `
  --destination s3://growthsent-data-552648196041-us-east-1-an/benchmarks/cc-main-2026-30-100/
```

Plain Common Crawl object keys stream from `https://data.commoncrawl.org/` by
default, which works for the public archive even where anonymous S3 API access
is denied. `s3://` sources retain optional unsigned reads. Output S3 requests
are always signed and need credentials authorized only for the chosen
destination prefix.

Path-list invocations now require `--max-inputs` and the command refuses a
scope above 1,000 inputs. For the approved production-v1 plan, including the
first-1,000 scope hash, resource sizing, costs, distinct S3 prefix, and
launch/cleanup procedures, see [the production v1 runbook](common-crawl-production-v1.md).

## Experimental optimized output mode

`tools/common_crawl_optimize.py` reads existing raw pages/links parts and
creates a separate normalized experiment. It never re-ingests WAT files.
URLs, hosts, anchors, and crawls receive deterministic lexicographic IDs;
edges retain crawl/timestamp and URL/anchor IDs, while pages retain metadata
keyed by URL ID. Host IDs live on the URL dictionary, preserving raw source and
target host information when an edge is reconstructed.
S3 input/download and upload operations retry with exponential backoff. To
publish the already-finalized local parts to the configured GrowthSent bucket,
make the external action explicit:

```powershell
python tools/common_crawl_wat_ingest.py `
  --crawl CC-MAIN-2026-30 `
  --input crawl-data/.../file.warc.wat.gz `
  --resume `
  --upload `
  --destination s3://growthsent-data-552648196041-us-east-1-an/
```

Uploads use deterministic object keys, so retrying or resuming an invocation
does not create duplicate dataset parts.
