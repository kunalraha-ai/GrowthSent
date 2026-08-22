# Common Crawl derived backlink v1: first 10K raw inputs

`v1` in the destination below is the immutable **derived schema/layout**
version; it is not the raw-ingestion version.

```text
production/common-crawl/backlink-derived/v1/cc-main-2026-30-first-10000/
  crawl=CC-MAIN-2026-30/
    dataset=backlink-details/input_shard=shard-000-of-010/
      target_host_bucket=0000/...
      ... target_host_bucket=1023/...
      DERIVED-MANIFEST.json
    dataset=backlink-host-rollups/input_shard=shard-000-of-010/
      target_host_bucket=<bucket>/target_host_key=<sha256-prefix>/...
  metrics/derive-shard-000-of-010.json
  control/derive-shards/derive-shard-000-of-010/
    lease.json
    DERIVED-PUBLICATION-MANIFEST.json
    DERIVED-SHARD-COMPLETED.json  # final write only
```

Each worker consumes only the 1,000 deterministic Links keys for its matching
raw shard. It validates the locked base/shard/plan hashes before downloading,
uses 24 GiB DuckDB memory, four threads, an explicit 1.25 TiB spill cap, and
requires all 1,024 bucket directories before publication. Raw v2 objects and
the existing 1K canary are never destinations.

Required worker envelope: `r6i.xlarge`, 32 GiB RAM, 1.5 TiB encrypted gp3,
IMDSv2 required, no inbound rules, HTTPS-only outbound, and the dedicated
least-privilege policy in `backlink-derived-production-10k-role-policy.json`.
