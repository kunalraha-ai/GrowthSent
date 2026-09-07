# Deployment packages

Deployment packages are intentionally kept in place because their manifests,
contracts, and scripts are part of the provenance for earlier data runs. This
guide tells an operator which package is current and which ones are retained
only for evidence or historical reference.

## Use for current work

| Package | Status | Purpose |
| --- | --- | --- |
| [common-crawl-gcp-link-index-v1](common-crawl-gcp-link-index-v1/README.md) | **Active** | Materializes the verified 100K R2 link corpus into a GCS serving index. This is the only default operator path for the current corpus. |

## Verified source lineage and recovery evidence

| Package | Status | Purpose |
| --- | --- | --- |
| [common-crawl-cloudflare-r2-standard1-hundred-thousand-self-recovery](common-crawl-cloudflare-r2-standard1-hundred-thousand-self-recovery/README.md) | Frozen evidence | Final 89K self-recovery control plane and verification supporting the completed 100K corpus. Do not relaunch for the current corpus. |
| [common-crawl-cloudflare-r2-standard1-regional-ramp](common-crawl-cloudflare-r2-standard1-regional-ramp/README.md) | Frozen evidence | Regional standard-1 capacity and recovery runner used to establish prior source outputs. |
| [common-crawl-production-v2](common-crawl-production-v2/README.md) | Historical provenance | Production-v2 manifests and bounded runbook material. |

## Historical calibration and canaries

| Package | Status | Purpose |
| --- | --- | --- |
| [common-crawl-cloudflare-r2-10-wat-canary](common-crawl-cloudflare-r2-10-wat-canary/README.md) | Historical / reusable only with a new approved scope | Ten-WAT Cloudflare canary. |
| [common-crawl-cloudflare-r2-50-wat-canary](common-crawl-cloudflare-r2-50-wat-canary/README.md) | Historical evidence | Fifty-WAT baseline, verification, and retirement helpers. |
| [common-crawl-cloudflare-r2-standard1-benchmark](common-crawl-cloudflare-r2-standard1-benchmark/README.md) | Historical calibration | Standard-1 benchmark material. |

## Superseded packages

| Package | Why it is not the default |
| --- | --- |
| [common-crawl-gcp-r2-25k](common-crawl-gcp-r2-25k/README.md) | Predates the verified R2 corpus and re-fetches raw WAT input. Do not use it for link-index v1. |
| [common-crawl-production-v1](common-crawl-production-v1/README.md) | Superseded by later contracts and evidence. |

## Operator rules

- Start at the README inside the selected package and use its reviewed wrapper
  scripts.
- Never reuse an output prefix. Immutable prefixes and completion markers make
  failure recovery auditable.
- Parent cloud credentials must remain local and out of command arguments,
  source, build artifacts, Workers, containers, and logs.
- Before any recovery, confirm whether a Worker or Batch job is active. A
  recovery that overlaps live work risks duplicate outputs and invalid evidence.
- Historical scripts are not a shortcut around the active pipeline's gates.
