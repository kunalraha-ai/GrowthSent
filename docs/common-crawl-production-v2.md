# Common Crawl production-v2 shard deployment

Status: local implementation only. This document does not authorize EC2,
SSM, IAM, S3, Atlas, or ingestion activity.

## Scope contract

Production-v2 is one new immutable run, currently named
`cc-main-2026-30-first-100000`. Its bundle must contain an explicit ordered
base manifest of exactly 100,000 CC-MAIN-2026-30 WAT paths and a deterministic
complete shard plan. It must never reuse the completed production-v1 prefix.

The base list is divided into contiguous, zero-based balanced shards. Given
`T = 100000`, `N = shardCount`, `q, r = divmod(T, N)`, shard `i` owns:

```text
start = i*q + min(i, r)
end   = start + q + (1 if i < r else 0)
inputs = base[start:end]
```

`N` must be at least 100, so every shard contains no more than 1,000 paths.
The base manifest, each shard manifest, and the shard plan carry canonical
SHA-256 locks. The manifest builder validates that every source path and every
deterministic 16-hex output suffix is unique.

## Isolation model

Each EC2 instance receives one fixed launch identity:

```text
RunId=cc-main-2026-30-first-100000
ShardId=<zero-based id>
ShardCount=<fixed count>
```

The v2 SSM runner validates that identity against its installed immutable
manifest before it writes a unit or starts work. It creates distinct local
paths for every shard:

```text
/opt/growthsent/control/common-crawl-production-v2/<run-id>/<artifact-shard-label>/
/opt/growthsent/work/common-crawl-production-v2/<run-id>/<artifact-shard-label>/
/etc/growthsent/common-crawl-production-v2/<run-id>/<artifact-shard-label>.env
/etc/systemd/system/growthsent-common-crawl-production-v2-<run-id>-<artifact-shard-label>.service
```

The ingester uses a separate remote control namespace per shard:

```text
s3://<bucket>/production/common-crawl/wat-pages-links/v2/<run-id>/
  control/base-manifest.json
  control/shard-plan.json
  control/shards/shard-<canonical-id>-of-<canonical-count>/
    input-manifest.json
    lease.json
    lifecycle.json
    run-progress.json
    run-summary.json
  crawl=CC-MAIN-2026-30/
    dataset=pages/part-<input-sha-prefix>.parquet
    dataset=links/part-<input-sha-prefix>.parquet
    dataset=metrics/part-<input-sha-prefix>.json
```

Pages, Links, and metrics retain the proven deterministic output naming. The
lease is created conditionally and refreshed/fenced with S3 ETags, so two
workers with the same run/shard identity cannot both proceed normally. A
replacement uses the same identity and `Resume`; it does not repartition or
select a new range.

An expired `running` lease is fail-closed: recovery requires explicit operator
confirmation that the prior worker is stopped via
`-Action Resume -AcknowledgeExpiredLeaseTakeover`. A normal graceful `Stop`
publishes a stopped lease and can be resumed without that acknowledgement.

## Required pre-launch review

1. Build the base manifest from a reviewed, immutable source list. Run the v2
   verifier locally and retain its output and all manifest SHA-256 values.
2. Build the deployment bundle; record its bundle SHA-256. Confirm it includes
   both v2 scripts plus the unchanged v1 engine and every manifest artifact.
3. Create a **new** v2 S3 run prefix. Grant the worker role narrowly scoped
   list/get/put and multipart permissions only for that prefix, including
   `control/` lease objects. Do not grant delete permission.
4. Configure an Amazon Linux 2023 Launch Template with the existing bounded
   worker shape (four process workers, 40 GiB gp3), SSM access, no inbound
   security-group rules, outbound HTTPS, public IPv4/Internet Gateway egress,
   IMDSv2 required, and instance metadata tags enabled.
5. Launch a single canary with one identity tuple. The bootstrap must write
   `/etc/growthsent/common-crawl-production-v2/launch-identity.env`; it does
   not start the runner.
6. Run `ValidateShardSetup` first. It performs no Common Crawl reads or S3
   writes; it only validates the release, identity, manifest set, and unit.
7. After separately approving the canary, use `Start` exactly once for that
   shard. Use `Status`, then `Resume` only with the same identity if needed.

## Local validation only

```powershell
pwsh -NoProfile -File deployment/common-crawl-production-v2/ssm-production-v2.ps1 `
  -ValidateSerializationOnly
```

This validates PowerShell parsing, generated Bash syntax, launch-template
bootstrap syntax, deterministic shard naming, required v2 ingestion flags,
and UTF-8 `file://` SSM parameter serialization. It does not call AWS.

## Canary stop condition

Do not scale beyond a single canary until the following are independently
verified on its new v2 prefix:

- remote base manifest and shard plan exactly match local artifacts;
- one shard's Pages, Links, and metrics triplets verify;
- its per-shard lifecycle/progress/summary are under the expected namespace;
- attempting a second worker with the same shard identity is rejected by the
  active S3 lease; and
- stopping and resuming the same shard reuses completed triplets without
  creating different deterministic output keys.

No v1 data, Common Crawl inputs, AWS resources, or S3 objects are changed by
this local implementation.
