# Common Crawl production-v2: first 10,000 WAT inputs

This is a local-only, reviewed plan. It does not provision an instance, send
SSM, write S3, or process a new WAT input. Production-v1 and its output prefix
remain separate and unchanged.

## Immutable scope

`cc-main-2026-30-first-10000` is the exact ordered prefix of the reviewed
100,000-path CC-MAIN-2026-30 source manifest. It is split into ten contiguous
immutable shards of 1,000 inputs:

| Field | Value |
| --- | --- |
| crawl | `CC-MAIN-2026-30` |
| inputs | 10,000 |
| run ID | `cc-main-2026-30-first-10000` |
| ordered input SHA-256 | `85b9d82fc11ef051c9a2e6424a22dbe865f9d4ba59df949f13b482c88e6f7226` |
| base manifest SHA-256 | `721f3b726f4283cee4321487584ad3577c7468f1df5f2a1b5fa054f983cf00d0` |
| shard-plan SHA-256 | `6939f2accb14d17f42e5c2ecc2e6c5b0ce3f405fd6b0474f75435e614d6ae54a` |
| per-shard ceiling | exactly 1,000 inputs |

The manifests are in
`deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/`.
`tools/verify_common_crawl_v2_run.py` validates ordered union, no overlap,
every base/shard hash, and deterministic output-suffix uniqueness before any
worker can start.

## S3 layout

Raw output uses a new prefix and retains the production-v1 file schemas and
deterministic names:

```text
s3://growthsent-data-552648196041-us-east-1-an/
  production/common-crawl/wat-pages-links/v2/
    cc-main-2026-30-first-10000/
      crawl=CC-MAIN-2026-30/
        dataset=pages/part-<input-sha256-prefix>.parquet
        dataset=links/part-<input-sha256-prefix>.parquet
        dataset=metrics/part-<input-sha256-prefix>.json
      control/base-manifest.json
      control/shard-plan.json
      control/shards/shard-000-of-010/{input-manifest,lease,lifecycle,run-progress,run-summary}.json
      ... shard-009-of-010/...
```

The v2 ingester conditionally publishes immutable control documents and uses a
per-shard conditional S3 lease. It resumes only when the same run ID, base
manifest, shard manifest, shard count, and input hashes match. A competing
worker cannot own a live shard lease; deterministic output keys are never
overwritten by normal resume logic.

## Derived backlink serving artifacts

The raw Links Parquet dataset remains authoritative. The separately invoked
`tools/common_crawl_backlink_derive.py` never changes Pages, Links, or metrics
schemas. For every completed 1,000-input raw shard it writes sorted ZSTD detail
files under a deterministic 1,024-way target-host bucket:

```text
production/common-crawl/backlink-derived/v1/
  cc-main-2026-30-first-10000/
    crawl=CC-MAIN-2026-30/
      dataset=backlink-details/
        input_shard=shard-000-of-010/
          target_host_bucket=0000/data_0.parquet
          ... target_host_bucket=1023/data_0.parquet
          DERIVED-MANIFEST.json
      dataset=backlink-host-rollups/
        target_host_bucket=<bucket>/target_host_key=<sha256-prefix>/
          dataset=domain-summary/part.parquet
          dataset=referring-hosts/part.parquet
          dataset=top-anchors/part.parquet
          dataset=top-linked-pages/part.parquet
          DERIVED-MANIFEST.json
```

`target_host_bucket` is `int(sha256(target_host)[:3], 16) >> 2`, formatted as
a four-digit decimal string. A lookup supplies both the computed bucket and
the exact normalized target host. The detail stage sorts by bucket and target
host so Parquet row-group statistics can further prune the exact-host lookup.

The host rollups are deliberately materialized per requested/approved host,
not globally. Their factual fields are:

- domain summary: observed link rows, unique referring hosts, unique target
  pages, non-empty anchor rows, crawl/run/schema metadata;
- referring hosts: target host, source host, observed link row count;
- top anchors: target host, raw anchor, observed link row count;
- top linked pages: target host, target URL, observed link row count,
  referring-host count.

These are **raw HTML link observations**, not global SEO backlink counts.
External/internal classification stays in the application’s existing `tldts`
logic; this derived worker intentionally does not approximate registrable
domains. The raw anchor is retained unchanged.

## Serving decision

Use a hybrid model:

1. keep raw Pages/Links/Metrics in S3 and Atlas Data Federation for forensic
   and analytical access;
2. use target-host-bucketed detail Parquet for bounded, paginated raw link
   observations;
3. persist/reuse only requested domain rollups in the derived prefix and,
   later, a versioned short-TTL operational-Mongo cache/lease for response
   coalescing.

Do not globally materialize all target-host/anchor/page combinations: the
100-file local probe already had approximately 2.11M target hosts, 40.66M
target-host/anchor pairs, and 64.05M target-host/target-page pairs. A global
rollup at 10K would approach raw graph scale and is neither compact nor
appropriate for the MVP.

## Future serving query shape

For `GET /api/v1/backlinks?domain=example.com` after the derived catalog is
configured:

1. normalize the exact host as today and calculate its deterministic bucket;
2. query the matching ten shard bucket prefixes with both
   `target_host_bucket` and exact `target_host`, with narrow projection and
   current page limit;
3. reuse a matching per-host rollup only when its run/base-manifest version
   matches; otherwise return the existing bounded partial/unavailable contract;
4. apply the application’s registrable-domain external-link filter before
   displaying external backlink observations.

No global `count`, `group`, or `sort` over the raw link graph belongs in the
interactive request path.

## Commands requiring later approval

Build/re-verify the reviewed release locally:

```powershell
python tools/verify_common_crawl_v2_run.py `
  --base-manifest deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/base-manifest.json `
  --shard-dir deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/shards `
  --shard-plan deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-10000/shards/shard-plan.json `
  --expected-input-count 10000
```

After IAM and the new S3 prefix have been explicitly approved, install the
reviewed release on a worker, validate a shard, and only then start it:

```powershell
$release = '<reviewed v2 bundle SHA-256>'
$common = @{
  InstanceId = 'i-<worker-for-this-shard>'
  Region = 'us-east-1'
  RunId = 'cc-main-2026-30-first-10000'
  ShardId = 0
  ShardCount = 10
  ReleaseSha256 = $release
}

.\deployment\common-crawl-production-v2\ssm-install-production-v2.ps1 `
  -InstanceId $common.InstanceId -Region $common.Region
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 -Action ValidateShardSetup @common
.\deployment\common-crawl-production-v2\ssm-production-v2.ps1 -Action Start @common
```

Repeat only for the ten immutable shard IDs `0..9`; never substitute another
run ID, count, manifest, or destination. No command in this document has been
executed against AWS.
