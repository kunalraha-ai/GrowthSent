# Backlink-derived 1K canary

This is a one-time, bounded validation of the target-host-derived Parquet
layout. It is **not** a WAT ingestion and it must never target a raw v1/v2
prefix.

The worker reads exactly these existing v1 Links objects, with no write access
to that prefix:

```text
s3://growthsent-data-552648196041-us-east-1-an/
production/common-crawl/wat-pages-links/v1/
cc-main-2026-30-first-1000/crawl=CC-MAIN-2026-30/dataset=links/
```

It writes only the isolated prefix below, publishing `CANARY-COMPLETED.json`
last as the logical completion marker:

```text
s3://growthsent-data-552648196041-us-east-1-an/
production/common-crawl/backlink-derived-canary/v1/
cc-main-2026-30-first-1000/
```

The canary is hard-coded to exactly 1,000 source objects totaling
79,181,489,365 bytes. Its build command uses 4 threads, 24 GiB DuckDB memory,
and a 1,024-way `target_host_bucket` layout. It has no CLI parameter that can
substitute a WAT manifest, expand the input prefix, or write a raw output.

The worker is expected to be a single disposable `r6i.xlarge` (4 vCPU, 32
GiB) with an encrypted 500 GiB gp3 root volume and a 24-hour systemd runtime
limit. The generated systemd service is the only long-running process; an SSM
caller may disconnect safely. It does not terminate the instance itself.

Before mapping a Data Federation collection, verify all of the following:

1. `CANARY-COMPLETED.json` exists.
2. `metrics/DERIVED-CANARY-METRICS.json` reports exactly 1,000 input files.
3. `crawl=CC-MAIN-2026-30/dataset=backlink-details/.../DERIVED-MANIFEST.json`
   exists and lists exactly 1,024 deterministic detail Parquet files.
4. The new collection is isolated from existing production collections.

`backlink-derived-canary-run.sh` is transferred over SSM by the canary
controller; it is not an executable deployment command on its own.
