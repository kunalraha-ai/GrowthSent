# GrowthSent GCP/R2 25K preparation

This directory is a local-only sibling of `common-crawl-production-v2`. It is
the reviewed starting point for exactly this new immutable run:

```
cc-main-2026-30-offset-10000-count-25000
```

It does **not** modify, read for publication, merge with, or serve the golden
10K prefix:

```
production/common-crawl/backlink-derived/v1/cc-main-2026-30-first-10000/
```

No command in this directory provisions GCP, creates R2 credentials, starts a
Batch job, or writes an object until an operator explicitly takes those steps.

## Immutable 25K input proof

The source of truth is the reviewed ordered 100K manifest already in the v2
tree. `tools/build_common_crawl_gcp_r2_25k_run.py` selects only positions
`[10000,35000)`, then proves each condition below before writing the sibling
manifests:

- exactly 25,000 paths, in original order;
- 25 canonical shard manifests, exactly 1,000 inputs each;
- no duplicate inputs or deterministic output suffixes;
- no intersection with positions `[0,10000)` (the golden 10K);
- ordered union of all shards equals the base manifest;
- locked base and plan SHA-256 values.

Current local locks:

| Lock | SHA-256 |
| --- | --- |
| ordered inputs | `3625696e98191d77432c62068cfc0bc9eb0fcbc95e80c4d0ba8a62dbe0dd33cb` |
| base manifest | `33420340c9792d90e03c394cfba8590825777010d3aee2ee659e5010b5fc8d1f` |
| shard plan | `53c452b1015ea69fd419dc5c13ec4534181fba03319243575ff16d89a6ae49d1` |

Run the read-only verifier before every canary/wave:

```powershell
python tools/verify_common_crawl_gcp_r2_25k_run.py `
  --base-manifest deployment/common-crawl-gcp-r2-25k/manifests/cc-main-2026-30-offset-10000-count-25000/base-manifest.json `
  --shard-dir deployment/common-crawl-gcp-r2-25k/manifests/cc-main-2026-30-offset-10000-count-25000/shards
```

## Cloud-neutral data contract

Common Crawl is read only through the public official HTTPS endpoint. The bare
`crawl-data/...wat.gz` key remains the immutable input identity; a transport
URL cannot alter deterministic suffixes, metrics input values, or manifest
hashes.

The new R2 prefixes are deliberately separate:

```
production/common-crawl/wat-pages-links/v2/cc-main-2026-30-offset-10000-count-25000/
production/common-crawl/backlink-derived/v1/cc-main-2026-30-offset-10000-count-25000/
```

Raw payloads are `crawl=CC-MAIN-2026-30/dataset=pages|links|metrics/part-<16-hex>.{parquet,json}`.
Raw per-shard control objects live below `control/shards/shard-XXX-of-025/`.
Derived payloads preserve the approved `target_host_bucket=0000..1023` detail
layout and bounded host rollups, separated by `input_shard=shard-XXX-of-025`.

Every immutable R2 payload requires all of:

1. deterministic key;
2. exact `ContentLength`;
3. lowercase `growthsent-sha256` custom metadata containing the full-file hash;
4. initial `Content-MD5` request integrity; and
5. immutable conditional creation, followed by a post-write HeadObject check.

Existing objects are reused only when length and `growthsent-sha256` both
match. Missing metadata, a mismatch, or a write race fails closed. ETags and
multipart/composite checksums are not treated as full-file hashes.
`RAW-SHARD-COMPLETED.json` and `DERIVED-SHARD-COMPLETED.json` are written last.
Readers/catalog work must never expose a shard without its matching marker.

## HTTPS rate-limit policy

`common_crawl_http_source.py` streams gzip rather than buffering whole WAT
files. The default worker concurrency is **one** (maximum four only after a
successful controlled ramp). Retryable responses are 429, 500, 502, 503, and
504, plus bounded network/connection errors. The retry schedule starts at at
least 2 seconds, doubles with positive jitter, caps each wait at 45 seconds,
and stops after 8 attempts. Redirects fail closed. Per-input metrics include
attempts, retry count/statuses, bytes, response status, and elapsed time.

The initial GCP canary must start with one job and one source stream. Do not
repeat the previous multi-worker HTTP 503 storm; raise concurrency only after
measured sustained success.

## Google Cloud Batch topology (design only)

| Stage | Initial compatible worker | Disk | Spot policy | Bounded job |
| --- | --- | --- | --- | --- |
| raw | `n2-standard-4`, 4 vCPU / 16 GiB | 80 GB `pd-balanced` boot disk | Spot after one-WAT proof | 12 h, no automatic retry |
| derive | `n2-highmem-4`, 4 vCPU / 32 GiB | 1,600 GB `pd-ssd` boot disk | Standard for first 1K proof; Spot only after a clean recovery test | 16 h, no automatic retry |

The derive envelope is intentionally retained for compatibility: DuckDB
`memory_limit=24GB`, 4 threads, `max_temp_directory_size=1.25TiB`. The 1,600
GB `pd-ssd` boot disk is temporary Batch VM scratch and `autoDelete` is an
execution requirement. Do not claim local SSD capacity/availability until it
has been checked in the selected GCP zone; it is a later optimization, not a
canary dependency.

Each Batch job has one immutable canonical shard assignment. Batch task
identity replaces EC2 tags/IMDS. The job must supply the run/shard/count,
expected count, base/shard hashes, prefixes, reviewed release SHA and unique
attempt ID. The container build writes the reviewed archive SHA into a
read-only release-lock file; the runners validate it against the job value
before a source read or R2 write. The Batch image URI itself must be digest
pinned.

Use a subnet with no inbound firewall rule, an ephemeral external IPv4 only
for outbound HTTPS/R2 traffic, and no paid NAT gateway. Do not reserve a
static address. Confirm the project/region supports the selected machine,
Spot capacity, boot-disk size, Artifact Registry and Batch before execution.

## Least privilege and secret delivery

The design files under `iam/` are policy contracts, not applied policies.

- Raw worker: read exactly one Secret Manager version that contains an R2
  temporary credential limited to the new raw prefix.
- Derive worker: read exactly two versions: raw Links/Metrics read-only and
  derived prefix publication.
- Operator: Batch job creation plus `iam.serviceAccountUser` only on the two
  worker service accounts. It has no worker-secret access.
- Workers receive no Google Storage permissions, no Compute/Batch
  administration, no parent Cloudflare API token and no AWS permission.

R2 temporary credentials should be minted with exact bucket/path/action
restrictions through the Cloudflare R2 temporary-credential facility, stored
as a **specific** GCP Secret Manager version, and rotated per wave. The Python
secret helper retrieves the version with the VM service account, validates its
JSON, and passes it only to the child Python process. It does not write a file,
print a value, or put a credential in the Batch job definition.

## AWS dependency disposition

| Existing dependency and source | Disposition for this sibling |
| --- | --- |
| `tools/common_crawl_wat_ingest.py` `open_input` / `s3_client` | Parser only is reused; source transport is replaced by `common_crawl_http_source.py`. |
| `tools/common_crawl_wat_ingest_v2.py` S3 leases/control/output | Reimplemented using R2 conditional S3-compatible calls in `common_crawl_r2_store.py`. |
| `tools/common_crawl_backlink_derive_production_v1.py` AWS publisher | Retained untouched as golden reference; its compute semantics are reused through `common_crawl_backlink_derive.py`, with a new R2 publisher sibling. |
| `deployment/common-crawl-production-v2/ssm-*.ps1` | Remove entirely: Batch API/job state replaces SSM install/control. |
| `launch-template-bootstrap.sh`, `derive-launch-template-bootstrap.sh`, IMDS tags | Replace with explicit Batch immutable environment/job fields. |
| EC2/EBS/systemd | Replace with ephemeral Batch VMs, job deadline/retry, temporary PD scratch and process logs. |
| GrowthSent AWS S3 output/control state | Replace with R2 raw/derived prefixes and R2 conditional control objects. |
| `s3://commoncrawl` authenticated reads | Remove for new work; use official public HTTPS with bounded telemetry/retry. |

No AWS resource is needed for the new 25K data/control plane. Common Crawl
remains an external AWS-hosted public source; that is not GrowthSent-owned AWS
infrastructure.

## Canary sequence — explicit approval required at every boundary

0. Local tests and deterministic bundle verification only.
1. One WAT into an isolated `production/common-crawl/gcp-r2-canaries/v1/...`
   prefix; compare semantic Pages/Links/Metrics with an equivalent golden WAT
   run and verify R2 length/hash/reuse. Record actual GCP network cost.
2. Ten to twenty representative WATs with one HTTPS stream each; assess 503,
   retry rate, throughput, R2 upload throughput and cleanup.
3. New canonical raw shard 0 `[10000,11000)`, then its matching derive shard.
   Verify 1,024 buckets, manifests, bounded rollups, completion-last and no
   golden-prefix writes.
4. Only with approval, ramp remaining 24 raw/derive shards in bounded waves.
   Start at two concurrent HTTPS streams, observe, then consider four. Never
   jump directly to 25 concurrent public Common Crawl readers.

After every wave: list Batch jobs/VMs/disks/external IPs, confirm completed VMs
and auto-deleted boot disks, verify there are no static IPs, snapshots, load
balancers or NAT resources, and count only completed R2 control markers.

## Economics and future work

Measured 1K inputs were approximately 159.17 GB compressed; extrapolation is
about 3.98 TB compressed input for 25K. The planned raw output is roughly
2.12 TB and derived output roughly 0.54 TB, or 2.6–2.7 TB of GCP-to-R2 egress.
These are planning estimates, not a price quote. GCP incoming internet from
Common Crawl is normally free; GCP internet egress to R2 is the material cost
and must be priced in the selected region/tier before execution. R2 egress is
free, while R2 storage and operations follow the current R2 price sheet.

The initial compatibility canary keeps Pages, Links and Metrics. The current
derive consumes Links plus Metrics artifact contracts; Pages are not used by
derive and are a future storage-reduction candidate only after a separately
approved schema/version migration. A later direct WAT-to-target-bucket staging
design could remove the multi-hundred-GB DuckDB sort: details and source-host
edges are bucket-local; exact host, anchor and target-page rollups can be
incrementally compacted per bucket. That is a new correctness/performance
project, not part of the first GCP canary.

Future R2 Data Catalog/R2 SQL work must create a separate catalog-managed
Iceberg representation. The immutable Parquet source remains the fallback and
truth reference; neither beta service is made an irreversible single point of
failure.
