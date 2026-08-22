# GCP/R2 25K architecture and cost model

This is a reviewed design document only. It creates no resource and has no
credential value. Exact regional prices must be checked in the Google Cloud
Pricing Calculator immediately before a canary, because credits, Spot
availability, egress tier and disk pricing are project/region specific.

## Target flow

```text
Common Crawl public HTTPS (official data.commoncrawl.org)
  -> one immutable Google Cloud Batch task per canonical input shard
  -> local Python/PyArrow parser and temporary GCE scratch
  -> Cloudflare R2 immutable raw Pages / Links / Metrics / control
  -> one immutable Batch derive task per completed raw shard
  -> local DuckDB 1,024 target_host_bucket detail / bounded rollups
  -> Cloudflare R2 immutable derived v1 / completion marker
  -> [future, separate] Iceberg writer + R2 Data Catalog + R2 SQL
  -> Workers API cache/coalescing -> GrowthSent
```

The Batch API is the small control plane. R2 completion markers and fenced
conditional leases are run state. No SSM-like remote shell, database queue,
or continuously running VM is needed.

## Data and query layout

The initial GCP output preserves current raw schema and golden derive semantics.
It is not an Iceberg migration. The future catalog writer should create
separate Iceberg tables from only completed immutable shards:

| Iceberg table | Partition transform / columns | Interactive use |
| --- | --- | --- |
| `backlink_details_v1` | `run_id`, `input_shard`, `target_host_bucket`; sorted `target_host,target_url` | exact `target_host_bucket + target_host` details only |
| `backlink_domain_summary_v1` | `run_id`, `input_shard`, `target_host_bucket` | domain overview |
| `backlink_referring_hosts_v1` | same, sorted `target_host,source_host` | referring hosts |
| `backlink_top_anchors_v1` | same, sorted `target_host,anchor` | anchors |
| `backlink_top_pages_v1` | same, sorted `target_host,target_url` | linked pages |

`target_host_bucket = int(sha256(target_host)[:3], 16) >> 2`, decimal padded
to 0000–1023, remains a physical partition and explicit query predicate. Do
not query details by `target_host` alone. Keep input shards as a physical
partition until an independently verified compaction creates a new immutable
catalog version; compaction must not overwrite source Parquet.

For the current ~8-second API target, Workers should cache completed rollup
responses and bounded detail pages keyed by `(dataset version, target bucket,
target host, pagination)`. KV is appropriate only for small immutable lookup
metadata/catalog version pointers, not Parquet or per-domain truth data.
Durable Objects are optional later for request coalescing/refresh ownership;
they are not needed for the batch pipeline. R2 SQL/Data Catalog are beta, so
the direct immutable Parquet reader path remains the fallback until their p50,
p95,p99, files/bytes scanned and operational recovery behaviour pass a proof.

## Raw data retention assessment

`common_crawl_backlink_derive_gcp_25k.py` stages only raw **Links**, proving
the derive stage does not consume Pages. Metrics are also required because they
bind every Links object to its original input/key/size/hash before derive.
Pages are currently a technical-audit/reference output, not a backlink-derive
input. Keep all three through the GCP correctness canary. In a later schema
version, audit Pages can be retained selectively or generated separately after
an explicit product and migration decision; do not remove them from v2.

The future direct extraction option is technically plausible: parser workers
can emit target-host-bucketed link batches and local per-input metrics without
writing a global raw Links lake. Detail data and source-host edges are
bucket-local. Exact domain summaries, anchors and pages require incremental
bucket-local aggregation/compaction. This could remove the giant DuckDB global
sort, but needs semantic comparison against golden output and is not part of
the first GCP canary.

## Reliability and preemption model

- Bare manifests, deterministic object keys and `growthsent-sha256` bind work.
- Existing valid R2 objects are verified/reused; mismatch fails closed.
- R2 `If-None-Match` creates immutable payload/control objects; `If-Match`
  fences mutable leases.
- A VM preemption before completion leaves reusable verified payloads but no
  completion marker. Recovery requires an explicitly approved expired-lease
  takeover and cannot serve the partial shard.
- Batch retries are deliberately disabled. A preemption/error stops that
  shard; after its lease expires an operator creates at most one explicitly
  approved recovery job with `GROWTHSENT_ALLOW_EXPIRED_LEASE_TAKEOVER=1`.
  This avoids two Batch attempts ever treating an unexpired lease as abandoned.
- HTTPS source has one stream initially, retry telemetry, 2s+ positive jitter,
  a 45s individual delay ceiling and eight attempts. A 503/429 rise stops a
  ramp rather than multiplying request pressure.
- JSON logs must include run/shard/attempt, input source, success/failure,
  HTTP statuses/retries/bytes/time, R2 reused/uploaded/conflict counts,
  scratch/RSS/duckdb spill, and final state. They must never include tokens or
  endpoint credentials.

## Planning estimates

These are extrapolations, deliberately ranges rather than promises.

| Scope | Compressed Common Crawl input | raw output | derived output | GCP -> R2 output |
| --- | ---: | ---: | ---: | ---: |
| 1 WAT, typical | ~159 MB | ~85 MB | not applicable | ~85 MB |
| 1K canonical shard | ~159.2 GB | ~84.9 GB | ~21.4 GB | ~106 GB across raw+derived |
| 25K new inputs | ~3.98 TB | ~2.12 TB | ~0.54 TB | ~2.6–2.7 TB |
| later 65K new inputs | ~10.35 TB | ~5.52 TB | ~1.39 TB | ~6.9 TB |

The 10K golden derived reference is 214,367,837,062 bytes. If it remains
derived-only in R2, cumulative R2 after a 25K raw+derived batch is roughly
2.87 TB; after 100K cumulative processing it is roughly 9.8 TB before
compaction, replicas, or future Iceberg files.

Cost model, to price with the selected region before launch:

| Cost driver | optimistic | likely | pessimistic | What changes it |
| --- | ---: | ---: | ---: | --- |
| one-WAT raw canary | cents | <$1 | a few dollars | VM minimum billing, image pull, retry waits |
| 20-WAT raw canary | <$2 | low single digits | <$15 | HTTPS retry/throttle behavior |
| 1K raw compute+scratch | Spot low tens | tens | on-demand/retry high tens | runtime and Spot availability |
| 1K derive compute+1.6TB scratch | Spot tens | low hundreds | on-demand/retries hundreds | 3.85h baseline, PD-SSD time |
| 25K compute+scratch | hundreds | high hundreds | >$1K | wave parallelism, on-demand fallback |
| 25K GCP egress to R2 | hundreds | roughly $250–$400 | higher tier/region rate | current GCP internet egress tier/destination |

GCP incoming public HTTPS is normally not charged. Common Crawl HTTPS avoids
GrowthSent AWS S3/IAM/EC2 charges. The GCP-to-R2 internet egress line is the
largest uncertainty and can consume credits; verify the billing account,
region and destination-specific rate with the Pricing Calculator. R2 egress
is free, but R2 standard storage (roughly $0.015/GB-month under current list
pricing) makes 2.6–2.7 TB of incremental output roughly $40/month before
operations. R2 Class A/B operation volume should be counted but is expected to
be much smaller than transfer/compute for 25K.

Starting from approximately $2,000 GCP credit, no 25K commitment is safe until
the one-WAT, 20-WAT and 1K actual invoices/usage have been measured. Set a
Billing Budget alert below the credit balance and a Batch-wave budget limit;
credits, expiration and product eligibility are billing-account facts, not
assumed by this repository.

## Golden equivalence protocol

For a WAT from the existing 10K reference window, run the new HTTPS/R2 parser
under an isolated canary prefix and compare with the archived golden pipeline:

1. source bare key, deterministic 16-hex suffix and metrics input identity;
2. Pages and Links schemas, row counts, canonical sorted semantic rows;
3. Metrics counters and source telemetry fields (transport fields may differ);
4. content hashes where the pinned Python/PyArrow runtime gives byte equality;
5. derive bucket assignment, detail semantic rows and bounded rollup values.

If Parquet bytes differ due to serialization metadata, compare canonical Arrow
rows and schema/record counts. Any semantic mismatch blocks the next stage.
