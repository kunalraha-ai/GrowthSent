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
we add a one-WAT provision/start and read-only verifier. A passing remote
benchmark must show the semantic-v2 result matching the selected published
baseline, completion-marker-last, and resource telemetry within the
`standard-1` envelope. That evidence—not a generic quota figure—will determine
whether a 2 → 10 → 25 → 50 concurrency ramp is safe.
