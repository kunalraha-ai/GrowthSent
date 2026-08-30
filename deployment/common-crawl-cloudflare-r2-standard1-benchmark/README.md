# Cloudflare `standard-1` one-WAT benchmark

This is a local compilation gate for a deliberately bounded Cloudflare
Container benchmark. It determines whether one representative CC-MAIN-2026-30
WAT can run inside a `standard-1` Container before we make any concurrency or
quota decisions.

It is not a production launcher. Running the compilation gate does not call
the Cloudflare API, mint a credential, deploy a Worker, start a Container, or
write an R2 object.

## What it preserves

The benchmark selects entry zero from the reviewed, published ten-WAT
public-source semantic-v2 baseline. At a later explicitly approved remote run,
it will use the same public HTTPS source reader, parser, semantic digests,
immutable Pages/Links/Metrics objects, post-upload object verification, and
completion-marker-last rule as the verified ten-WAT canary.

The candidate output prefix is isolated from both production and prior
canaries:

```text
production/common-crawl/cloudflare-r2-standard1-benchmarks/v1/<benchmark-id>/
```

The runtime permits exactly one input and one active Container. The Worker is
configured with Cloudflare's `standard-1` instance type: 1/2 vCPU, 4 GiB
memory, and 8 GB disk. It retains the 110-minute hard timeout used by the
verified canary so that the first comparison tests resource shape rather than
a reduced time allowance.

## Local gate

From Ubuntu/WSL, run:

```bash
bash deployment/common-crawl-cloudflare-r2-standard1-benchmark/compile-gate-wsl.sh
```

The gate validates the reference manifest and generated Container config,
builds a secret-free release bundle and Container image locally, validates the
embedded Python runtime against the selected reference entry, and runs
`wrangler deploy --dry-run`. Its final `BENCHMARK-CONTEXT.json` explicitly
records that no remote start was permitted.

## Decision after the local gate

Only after this gate passes and a separate remote-run approval is given should
we provision one temporary Worker and start one benchmark Container. The remote
launcher requires an explicit baseline-object key as well as the matching local
manifest, so it cannot accidentally compare against a different ten-WAT shard.
A passing remote benchmark must show the semantic-v2 result matching the
selected published baseline, completion-marker-last, and resource telemetry
within the `standard-1` envelope. That evidence—not a generic quota figure—will
determine whether a 2 → 10 → 25 → 50 concurrency ramp is safe.

## Approved remote benchmark

When a one-WAT remote run is approved, set the exact local baseline and its
matching immutable R2 key. For the already prepared shard 05 baseline:

```bash
export GROWTHSENT_REFERENCE_MANIFEST=/tmp/growthsent-cloudflare-50-wat-reference-JCTjc8/shard-05/PUBLIC-SOURCE-BASELINE-MANIFEST.json
export GROWTHSENT_REFERENCE_BASELINE_KEY=production/common-crawl/audit/public-source-baseline/v2/cc-main-2026-30-50-wat-shard-05/PUBLIC-SOURCE-BASELINE-MANIFEST.json
bash deployment/common-crawl-cloudflare-r2-standard1-benchmark/provision-and-start-wsl.sh --approved-one-wat-standard1-benchmark
```

The launcher verifies that the published object matches the local manifest
hash, confirms the fresh benchmark prefix is empty using both `aws4fetch` and
the exact `boto3` client used in the Container, then deploys one temporary
Worker and requests one start. Do not rerun it after a start is accepted.

After the Container has finished, verify only that benchmark's R2 objects:

```bash
bash deployment/common-crawl-cloudflare-r2-standard1-benchmark/verify-benchmark-wsl.sh --benchmark-id <benchmark-id>
```

The verifier mints a new one-hour read-only child credential and requires the
exact seven-object contract, full JSON hash checks, matching semantic-v2
digests, and completion-marker-last publication.
