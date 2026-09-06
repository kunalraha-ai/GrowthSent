# GrowthSent link-index v1

This deployment materializes the already-verified CC-MAIN-2026-30 100,000-WAT
corpus into an SEO-serving index. It does **not** fetch WAT files from Common
Crawl and it does not overwrite the Cloudflare R2 corpus.

The first stage is intentionally small: a one-task catalog job reads immutable
`TASK-COMPLETED.json` records from the seven verified R2 campaign roots. It
accepts only one `links` Parquet artifact per source identity and fails unless
the exact locked manifest has all 100,000 distinct source keys. The catalog is
written once to private GCS with an `if_generation_match=0` precondition.

The catalog stage requires only the `r2-link-index-input-read` Secret Manager
version. The temporary credential is retrieved by the Batch service account
inside the task and is never placed in the job definition, image, logs, or GCS.
Refresh it immediately before a stage with:

```powershell
.\deployment\common-crawl-gcp-link-index-v1\scripts\mint-r2-read-secret.ps1
```

The helper prompts for the parent Cloudflare API token without echoing it,
mints a six-day `object-read-only` child credential scoped to the seven exact
source roots, and adds a new Secret Manager version. Job templates use
`versions/latest`, so no source edit is needed on renewal.

Do not use `common-crawl-gcp-r2-25k` for this work: that package re-fetches raw
WAT input and predates the verified R2 corpus.

## Build

From PowerShell at the repository root:

```powershell
.\deployment\common-crawl-gcp-link-index-v1\scripts\build-image.ps1
```

The command prints a digest-pinned image and its release SHA-256. Submit the
one-task catalog job with those exact values:

```powershell
.\deployment\common-crawl-gcp-link-index-v1\scripts\submit-catalog.ps1 `
  -ImageUri "us-central1-docker.pkg.dev/PROJECT/growthsent-containers/link-index-v1@sha256:DIGEST" `
  -ReleaseSha256 "RELEASE_SHA256"
```

Review its Cloud Logging output and the immutable GCS catalog before enabling
link-materialization tasks.

## Materialization and compaction

`batch/materialize-canary-job.template.json` deliberately processes only 100
catalog entries. The production materialization template has 100 disjoint
1,000-source tasks and a conservative parallelism of 25 (100 vCPU), below the
current 200-vCPU project quota. Every task writes target-domain partitions with
a stable bucket: the first three hex characters of `SHA-256(domain)`, shifted
right by two, giving 1,024 buckets.

Before full materialization, run the separate 1,000-source
`materialize-cost-probe-job.template.json`. It uses the same 4-vCPU, 30-GiB,
375-GB `pd-balanced` scratch topology as production and records elapsed time,
input/output bytes, and scratch-filesystem high-water usage in its immutable
task manifest. This is the cost and disk-sizing gate; do not infer production
cost from the 100-source functional canary alone. The companion WSL launcher
refuses to start until the immutable catalog exists and regional `SSD_TOTAL_GB`
quota has at least 375 GB available.

`pd-balanced` is intentionally used for scratch rather than Local SSD because
the project currently has only 100 GB Local SSD quota while one Local SSD
allocation is 375 GiB. The scratch disk is transient task workspace only; all
durable output is written with immutable preconditions to GCS. Audit Batch disk
resources after every terminal job and remove any unexpected orphaned disks.

After a successful probe, validate its immutable task manifest and print the
measured high-water data without changing GCS, R2, or Batch:

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/verify-materialize-cost-probe-wsl.sh JOB_ID OUTPUT_PREFIX
```

After every materialization task has a valid immutable task manifest,
`batch/compact-production-job.template.json` compacts each target bucket into
the private serving tables: domain summaries, referring domains, anchor text,
top linked pages, domain edges, and broken-link *candidates*. Candidate URLs
still require a separately rate-limited HTTP checker before the product may
call them broken backlinks.
