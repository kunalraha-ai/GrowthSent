# Project status

Last reviewed: 2026-09-07.

This is the durable status summary for the current `CC-MAIN-2026-30` link-data
campaign. It is deliberately separate from `context.md`, which contains
time-sensitive terminal history and handoff notes.

## Current state

| Stage | State | Evidence / next gate |
| --- | --- | --- |
| Common Crawl source processing | Verified complete | 100,000 locked WAT source identities were verified across the original runs and final recovery. Do not relaunch WAT processing for this corpus. |
| R2 source corpus | Immutable input | Seven verified R2 campaign roots provide the source link artifacts. They are read-only to the GCP index pipeline. |
| GCP catalog | Verified complete | The catalog contains exactly 100,000 distinct source identities and link artifacts. |
| Materialization cost probe | In progress / operator-gated | A one-task, 1,000-source probe validates measured time, scratch-disk high-water, and output layout before full materialization. Verify the latest submitted probe rather than relying on a historical Batch job ID. |
| Production materialization | Not started | Requires a successful, reviewed cost-probe result and an explicit approval. |
| Compaction | Not started | Runs only after every materialization task has a valid immutable task manifest. |
| Product serving adapter | Not started | The dashboard link-intelligence views remain mock-backed until a read API over the verified compacted index is implemented. |

## Terms used in this project

- **WAT**: a Common Crawl Web Archive Transformation file. The 100,000 WAT
  source range is the immutable acquisition scope for this campaign.
- **Source identity**: one locked input position in that source range. Counts
  and recovery membership are based on this identity, not a transient task ID.
- **Link artifact**: the immutable Parquet `links` output associated with one
  completed source identity.
- **Catalog**: the GCS manifest that maps all 100,000 source identities to
  their verified R2 link artifacts.
- **Materialization**: converting catalog entries into target-domain bucketed
  Parquet output in GCS.
- **Compaction**: merging materialized bucket files into the serving-oriented
  layout. It is a separate controlled phase.

## Operational rules

- The Cloudflare 100K corpus is complete. Do not rerun a historical Cloudflare
  launcher merely to begin index work.
- The GCP pipeline has read-only credentials for its R2 input roots and writes
  durable results to fresh GCS prefixes using immutable preconditions.
- A failed Batch attempt does not make partial output authoritative. Use the
  corresponding verifier and task manifest before reusing any result.
- The latest job ID is operational state, not repository configuration. Get it
  from the launcher output or Cloud Batch before diagnosing or verifying.
- Do not connect live product claims, backlink counts, or authority scores to
  the UI until the serving adapter and its contract tests exist.

## Canonical operator entrypoint

For the active data path, begin with the
[GCP link-index README](../deployment/common-crawl-gcp-link-index-v1/README.md).
It describes the catalog verifier, cost probe, full materialization, and
compaction gates. Use its reviewed WSL scripts; do not compose cloud commands
from historical notes.
