# GrowthSent — Continuation Context

> Purpose: paste or point a new Codex session at this document before it changes
> anything. It records the verified state of the Common Crawl project, the current
> GCP job, prior failures, and the safe path to a production SEO link-intelligence
> product. It intentionally contains **no API tokens, R2 credentials, secret
> values, or customer data**.

Last updated: 2026-09-06 (Asia/Kolkata)

## Read this first

- The user is Kunal, working from Windows + WSL:
  `C:\Users\kunal\OneDrive\pineapple\GrowthSent`
  / `/mnt/c/Users/kunal/OneDrive/pineapple/GrowthSent`.
- The user values speed, but has been burned by duplicate launches and incomplete
  recoveries. Be decisive, but use immutable inventories, fresh output prefixes,
  and read-only checks before any retry.
- Never request or print raw Cloudflare or Google credentials. The user enters
  parent Cloudflare tokens interactively. Scripts mint narrowly scoped, temporary
  child credentials themselves.
- Never rerun a terminal Batch/Cloudflare campaign under the same output prefix.
  A job must be diagnosed first; use a fresh prefix or immutable recovery contract.
- Do not overwrite existing frontend changes or push to GitHub without an explicit
  new request. The user most recently asked for this handoff document.

## Goal

Turn verified Common Crawl `CC-MAIN-2026-30` processing of 100,000 WAT files into
a queryable SEO link-intelligence product. The initial frontend product is meant
to support:

1. Backlink Explorer — domain search, total links and referring domains.
2. Domain Rating — explicitly PageRank-style only after a real graph-scoring job.
3. Top Linked Pages.
4. Anchor Text Cloud/distribution.
5. Broken Backlinks Finder — label as *candidates* until URLs have been checked
   through a rate-limited HTTP validation phase.
6. Competitor Gap Analysis.

The 100,000 WAT corpus is processed and exactly verified. What remains is making
the already-produced link artifacts searchable at domain level, then exposing
them safely through an API to the frontend.

## Verified source-corpus state

### Final proof

The final read-only verification completed successfully:

```json
{
  "status": "verified",
  "crawl": "CC-MAIN-2026-30",
  "source_identity_count": 100000,
  "final_recovery_task_count": 32,
  "final_recovery_object_count": 224,
  "final_recovery_total_bytes": 2614222384,
  "report": "/tmp/growthsent-cloudflare-final-100k-verify-8LTxKy/FINAL-100K-VERIFICATION-REPORT.json"
}
```

This is proof of **100,000 distinct locked WAT source identities**, not proof that
a compact domain-index database already exists. Do not re-run WAT extraction.

### Source storage

- Cloudflare account ID: `4a30e8ac877d9f65ee9a0ecc5df16146`
- R2 bucket: `growthsent-data-lake`
- The link-index catalog is permitted to read only these seven immutable source
  roots (the child R2 credential is scoped to this exact set):

```text
production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-20260902t021855z-s1-256-e3cbfc2f/
production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-20260902t065907z-s1-256lane-be9f028c/
production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-20260902t152808z-s1-256lane-b40e1e01/
production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-20260901t151022z-standard1-regional-7e6a8887/
production/common-crawl/cloudflare-r2-regional-ramps/v1/cc-main-2026-30-20260901t173835z-standard1-128rcvr-caa9f4fb/
production/common-crawl/cloudflare-r2-final-campaigns/v1/cc-main-2026-30-20260903t075508z-s1-89kprep-0b64d2c1/
production/common-crawl/cloudflare-r2-final-recoveries/v1/cc-main-2026-30-20260904t151133z-s1-89rcvr-55c545a1/
```

The task outputs contain per-WAT Parquet/JSON artifacts. They are not suitable as
a browser query service and must remain immutable.

## Why the GCP link-index pipeline exists

The Cloudflare Containers did the WAT parsing and wrote immutable R2 results.
The next job is a *different* workload: index construction. It needs to group
links by target domain, aggregate anchors/pages/referrers, and produce small,
fast serving partitions. Direct browser reads from R2 are unsafe and would scan
far too much data per query.

GCP Batch is currently the one-time indexing compute. It reads the verified R2
link artifacts through a temporary, read-only credential and writes private GCS
index artifacts. This does **not** repeat Common Crawl downloads or WAT parsing.

## Cloudflare capability decision (researched Sep 6)

Cloudflare R2 SQL is useful for a future serving layer, but it is not the fast
shortcut for the current raw output:

- R2 SQL is in open/public beta and queries Apache Iceberg tables managed by R2
  Data Catalog, not arbitrary Parquet objects in an R2 folder.
- It is read-only: it cannot create, update, or compact tables. A writer such as
  PyIceberg or Spark must first build domain-partitioned Iceberg tables.
- It supports filters, joins, and aggregates, but large joins/high-cardinality
  grouping can be rejected or time out during beta. Precomputed domain serving
  tables are required for interactive SEO lookups.
- R2 SQL credentials include R2 SQL, R2 Data Catalog, and R2 Storage permissions.
  Never expose them to the browser. A Worker/API must proxy parameterized queries.

Useful official references:

- https://developers.cloudflare.com/r2-sql/
- https://developers.cloudflare.com/r2-sql/query-data/
- https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/
- https://developers.cloudflare.com/r2-data-catalog/
- https://developers.cloudflare.com/r2-data-catalog/config-examples/pyiceberg/

Decision: **do not pivot to R2 SQL during this GCP catalog/index run.** It would
require a new Iceberg backfill and delay first production. After the index is
live, benchmark a small R2 Data Catalog serving-table sample if a Cloudflare-only
query layer is still desired.

## GCP environment

- Project ID: `growthsent-link-index`
- Project number: `498930285709`
- Region: `us-central1`
- Private GCS bucket: `gs://growthsent-link-index-498930285709`
- Artifact Registry repository:
  `us-central1-docker.pkg.dev/growthsent-link-index/growthsent-containers`
- Batch runner service account:
  `growthsent-link-index-runner@growthsent-link-index.iam.gserviceaccount.com`
- Relevant quota discovered: 200 total CPU, 200 N2 CPU, and 50 instances.
  Existing production templates are deliberately conservative at 25 × 4-vCPU
  workers (100 vCPU). Raising to 50 workers may be possible, but verify regional
  Local SSD quota before changing it: each worker requests a 375 GB local SSD.
- Budget was set to $1,600 (alerts do not automatically stop compute).
- The `r2-link-index-input-read` Google Secret Manager secret has a valid latest
  version with a six-day, seven-prefix, R2 object-read-only child credential.
  Refresh it immediately before a stage if it might expire:

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/mint-r2-read-secret-wsl.sh
```

The script requires `jq`. It prompts for a Cloudflare parent token hidden and
publishes a new Secret Manager version without logging its value.

## Current state: active catalog job

The latest catalog image was built successfully after all known fixes:

```json
{
  "status": "published",
  "release_sha256": "47899e4b8b2c371cb88cefffd5b6c3058a88efdb27f52bc62e85ca8faa6a444c",
  "image": "us-central1-docker.pkg.dev/growthsent-link-index/growthsent-containers/link-index-v1@sha256:fa92224d9a3c6a3f90b1eb14e783aa00fd35297df37e670136940f6393cdd7f4"
}
```

The latest job was accepted on 2026-09-06:

```text
Job ID: growthsent-link-index-catalog-v1-20260906042911
Batch UID: growthsent-link-in-50fd22cb-f96e-40c60
Stage: catalog
Initial state: QUEUED
```

It uses the image above and only 2 vCPU / 8 GiB because it reads completion
metadata and writes a catalog—not the full link corpus. It is independent of the
local terminal after submission. Do not submit a duplicate catalog job while this
one is `QUEUED` or `RUNNING`.

Monitor with:

```bash
gcloud batch jobs describe growthsent-link-index-catalog-v1-20260906042911 --location us-central1 --format='value(status.state)'
```

Expected catalog runtime is approximately 10–12 hours once running. That is based
on a prior attempt which reached the final upload after about 9.5 hours; the prior
failure was a GCS client checksum setting, not source-data failure.

If it fails, diagnose first—do not blindly resubmit:

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/diagnose-catalog-wsl.sh growthsent-link-index-catalog-v1-20260906042911
```

### Prepared but not launched: 1,000-source cost probe

The original production templates requested a 375-GB Local SSD for every
materialization and compaction worker. The current `us-central1`
`LOCAL_SSD_TOTAL_GB` quota is only 100 GB, so that topology cannot start. The
templates were changed locally to use 375-GB `pd-balanced` scratch disks instead.

Before any full materialization launch, rebuild the image and run the dedicated
one-task, 1,000-source cost probe. It has production CPU, memory, disk, and
source-count shape, but a distinct immutable output prefix. Its summary records
elapsed time, verified input bytes, output bytes, and scratch-filesystem
high-water usage. The launcher refuses to submit unless the catalog exists and
there is at least 375 GB of available `SSD_TOTAL_GB` quota.

The probe is intentionally **not launched** while the catalog job is active or
before its immutable catalog object is verified.

After the probe reports `SUCCEEDED`, run the read-only verifier:

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/verify-materialize-cost-probe-wsl.sh JOB_ID OUTPUT_PREFIX
```

It accepts only the single expected 1,000-source task manifest and prints the
measured runtime, input/output bytes, scratch high-water mark, and row counts.

## Prior catalog failures and fixes already made

These must not be reintroduced.

1. **Invalid/expired R2 secret JSON**
   - Symptom: old catalog task failed at startup reading the secret.
   - Fix: user minted a valid scoped R2 read-only child credential and created
     version 2 of `r2-link-index-input-read`.

2. **Wrong completion-marker kind constant**
   - Symptom: `completion marker kind is not accepted`.
   - Cause: catalog had the wrong hardcoded kind.
   - Fix in `tools/common_crawl_link_index_catalog_v1.py`:

   ```python
   TASK_COMPLETION_KIND = "growthsent-cloudflare-r2-standard1-regional-task-completed-v1"
   ```

3. **Unsupported GCS checksum value**
   - Symptom from job `growthsent-link-index-catalog-v1-20260905132420`:

   ```text
   ValueError: checksum must be ``'md5'``, ``'crc32c'`` or ``None``
   ```

   - Cause: `google-cloud-storage` does not accept `checksum="auto"` in the
     installed version. The failure occurred before catalog upload completion.
   - Fix: all catalog, materializer, and compactor GCS upload/download calls now
     use `checksum="crc32c"`.
   - The currently running catalog image contains this fix.

4. **Misleading Cloud Build log-writer warning**
   - Cloud Build warns that the compute service account cannot write Cloud Logging.
   - It does not block builds; the current build completed successfully. Do not
     treat that warning as the root cause of a Batch failure.

## Pipeline code map

All of these are currently uncommitted project work. Preserve them unless the
user explicitly asks for a cleanup/commit/push.

```text
deployment/common-crawl-gcp-link-index-v1/
  README.md
  requirements.txt
  container/Dockerfile
  cloudbuild.yaml
  batch/catalog-job.template.json
  batch/materialize-canary-job.template.json
  batch/materialize-production-job.template.json
  batch/compact-production-job.template.json
  runners/catalog-task.sh
  runners/materialize-task.sh
  runners/compact-bucket-task.sh
  scripts/build-image-wsl.sh
  scripts/submit-catalog-wsl.sh
  scripts/diagnose-catalog-wsl.sh
  scripts/mint-r2-read-secret-wsl.sh

tools/
  common_crawl_link_index_catalog_v1.py
  common_crawl_link_index_materialize_v1.py
  common_crawl_link_index_compact_v1.py
```

### Stage 1 — catalog (currently running)

`common_crawl_link_index_catalog_v1.py`:

- Reads only `TASK-COMPLETED.json` under the seven verified R2 roots.
- Validates the complete exact 100,000-source identity partition.
- Selects exactly one `links` Parquet artifact per WAT source identity.
- Writes a private GCS catalog object using an immutable create precondition:
  `catalogs/v1/cc-main-2026-30/source-links-catalog.json`
- Does not download WAT input and does not mutate R2.

### Stage 2 — materialization

`common_crawl_link_index_materialize_v1.py`:

- Reads the catalog and selected R2 links Parquet artifacts.
- Checks bytes and SHA-256 values from catalog metadata before use.
- Produces target-domain-bucketed intermediate Parquet records in private GCS:
  domain edges, referring domains, anchors, top pages, page referrers, and
  broken-backlink *candidates*.
- Uses stable domain bucket assignment: 1,024 buckets based on a SHA-256-derived
  domain bucket.
- Production template: 100 disjoint tasks × 1,000 source identities, 25 parallel
  tasks, 4 vCPU / 30 GiB each, up to two retries total.
- A 100-source canary must be run and checked before production materialization.

### Stage 3 — compaction

`common_crawl_link_index_compact_v1.py`:

- Reads only GCS intermediate outputs after all materialization tasks have valid
  immutable manifests.
- Compacts per target-domain bucket to serving tables:
  domain summaries, referring domains, anchor text, top linked pages, domain
  edges, and broken-link candidates.
- Template has 1,024 tasks, 25 parallel, 4 vCPU / 30 GiB each.
- Never call a candidate URL "broken" without the later, rate-limited checker.

## Required order after the catalog succeeds

1. Perform a read-only catalog verification.
   - Confirm GCS object exists once, is immutable, contains 100,000 source
     identities, accepts only `links` artifacts, and has no duplicate source keys.
   - If no dedicated verifier exists, add one before launching materialization;
     never inspect by downloading secrets or bypassing checks.

2. Run a **100-source materialization canary** against a fresh GCS output prefix.
   - Check task manifest, all output parquet metadata/checksums, domain bucket
     distribution, and sample aggregate correctness.
   - Do not use production output names or overwrite paths.

3. Check capacity before full materialization.
   - The current templates have only 25 concurrent workers (100 vCPU), although
     project CPU quota is 200.
   - Verify `LOCAL_SSD_TOTAL_GB` and relevant regional quotas first. If adequate,
     a reviewed increase to 50 workers (200 vCPU) is reasonable and reduces
     throughput time. Do not assume it without the quota evidence.

4. Run full materialization in a new output prefix.
   - Estimated 12–30 hours at 50 workers, dependent on actual link Parquet size
     and R2/GCS throughput. The 12-hour task duration limit is a guardrail, not
     a promise that every task uses 12 hours.

5. Run full compaction in a new serving prefix after verifying all 100 materialize
   task manifests.
   - Estimated 12–36 hours at 50 workers. Domain skew can make it slower.

6. Add a secure serving API.
   - Frontend must call an API, never R2/GCS directly.
   - Use parameterized domain lookups, strict URL/domain normalization, bounded
     pagination/cursors, tenant auth/rate limits, and response caching.
   - It may be a Cloudflare Worker or another reviewed API runtime. Keep storage
     credentials server-side.

7. Integrate the frontend and deploy only after API data-contract tests pass.

8. Run later/nonblocking enrichment:
   - PageRank/graph authority scoring for actual Domain Rating.
   - Rate-limited external URL checks and retries for confirmed broken backlinks.

## Time expectations

These are estimates, not promises:

| Work | Estimate | Dependency |
|---|---:|---|
| Current catalog | 10–12 h after it starts | active Batch job |
| Catalog proof + materialization canary | 1–3 h | catalog success |
| Full materialization at 50 workers | 12–30 h | canary + quota proof |
| Serving-table compaction at 50 workers | 12–36 h | complete materialization |
| API integration, deployment tests | 4–8 h, mostly parallel | serving contract |

The initial explorer could be production-ready in approximately 2–4 days after
the catalog succeeds. PageRank-style DR and confirmed broken links are separate
enrichment stages and should not block the first reliable launch.

## Frontend state

The dashboard has local, intentionally unpushed interface work for the requested
SEO product pages. It is currently presentation-only; do not manufacture metrics
or claim it is connected to the data index.

Known modified/untracked frontend files:

```text
src/components/dashboard/AppConsole.tsx
src/components/dashboard/Sidebar.tsx
src/components/dashboard/LinkIntelligenceView.tsx
src/index.css
```

The current frontend includes navigation/views for the requested backlink
features. The next coding session should keep this UI, define a stable backend
response contract, and replace placeholders only after compact serving tables
exist.

## Repository state and editing rules

- Root `AGENTS.md` describes a React 19 + Vite + Tailwind v4 Figma Make app.
- The dev server is already available through the Figma Make preview; do not
  start another one manually.
- Use `apply_patch` for source-file changes; do not write source files with shell
  redirection or Python one-liners.
- Use `rg` for repository search.
- Preserve unrelated work in a dirty tree.
- Do not run destructive git commands (`reset --hard`, checkout/revert) unless
  the user explicitly asks.
- Do not push to GitHub unless the user explicitly asks in that session.
- Before future commits, review `git status --short`, inspect every untracked
  deployment/tool file, and ensure no temporary R2 child credentials, `.env`,
  `/tmp` artifacts, or generated `.boto3-preflight-packages` are included.

## Useful WSL commands

The commands below do not include secrets. Keep each command on one physical
line unless shell line-continuation backslashes are intentionally used.

### Monitor the active catalog job

```bash
gcloud batch jobs describe growthsent-link-index-catalog-v1-20260906042911 --location us-central1 --format='value(status.state)'
```

### Diagnose only if it is terminally failed

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/diagnose-catalog-wsl.sh growthsent-link-index-catalog-v1-20260906042911
```

### Rebuild image after a code change

```bash
bash deployment/common-crawl-gcp-link-index-v1/scripts/build-image-wsl.sh
```

It prints a `release_sha256` and digest-pinned image. Use the *new* release value
only for a new job after a genuine failure or intended code change.

### Submit catalog only when no active/successful immutable catalog exists

```bash
GROWTHSENT_CATALOG_RELEASE_SHA256=REPLACE_WITH_NEW_RELEASE_SHA256 bash deployment/common-crawl-gcp-link-index-v1/scripts/submit-catalog-wsl.sh
```

Do not substitute an old image release. Do not run this while the current job is
queued or running.

## What not to do

- Do not re-run Cloudflare’s 100K WAT campaign. It is complete and verified.
- Do not ask the browser to query R2, GCS, R2 SQL, or an object store directly.
- Do not treat task output as a production database.
- Do not call broken-link candidates confirmed broken backlinks.
- Do not call a simple link count a PageRank/Domain Rating score.
- Do not launch 50 GCP workers without proving CPU, instance, **and local SSD**
  quota in `us-central1`.
- Do not retry a job simply because a command was pasted incorrectly or the
  terminal closed. Check remote job state first.
- Do not expose the R2 parent credential or temporary child credential in logs,
  source, Git, chat, job definitions, or frontend configuration.

## Recommended opening prompt for the next Codex session

```text
Read context.md in the repository root completely before taking any action. We
have a verified 100,000-WAT CC-MAIN-2026-30 corpus in Cloudflare R2 and an active
GCP Batch catalog job. First check the exact Batch job status named in context.md.
Do not relaunch WAT processing or duplicate the catalog job. Preserve all dirty
frontend and deployment changes, do not expose credentials, and use the
post-catalog order and safety checks documented there.
```
