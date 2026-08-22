# GrowthSent

GrowthSent is a bounded, evidence-first SEO and search-intelligence application. It helps teams run technical audits, examine verified Google Search Console performance, and explore a clearly labelled Common Crawl link-observation preview.

It is deliberately designed to be credible before it is expansive: an audit only reports checks supported by collected evidence, and link data is never presented as a complete commercial backlink index.

## What GrowthSent does

- **Technical SEO audits** — durable, bounded crawls with evidence-backed page findings and explicit queued, crawling, analysing, complete, and failed states.
- **Search Intelligence** — Google Search Console views for clicks, impressions, CTR, average position, period comparisons, quick wins, content decay, CTR opportunities, potential cannibalisation, winners and losers, queries, and pages.
- **Backlink preview** — Common Crawl WAT anchor-link observations with exact-host lookup, external-link semantics, and a strict serving budget.
- **Operational safety** — durable MongoDB jobs, leases, heartbeats, retry backoff, crawl admission controls, and SSRF/origin protections.

## Product truthfulness

GrowthSent does not manufacture SEO facts or analytics.

- A pass/fail audit check appears only when the crawler persisted sufficient evidence.
- Failed or unfetched pages are never treated as indexable or as a successful audit.
- `robots.txt` and sitemap absence are reported only from confirmed HTTP-level evidence; fetch failures remain unavailable/not evaluated.
- Search Intelligence uses real GSC metrics only. It does not create search-volume, difficulty, traffic, authority, or AI-derived “fact” scores.
- Backlink data is raw Common Crawl link observation data—not a complete web index, authority score, traffic estimate, or total-backlink count.

## Architecture

```text
Browser
  │
  ├─ React + Vite dashboard
  │
  └─ /api/v1/* → Vercel function → application router
                              │
                              ├─ MongoDB Atlas: users, audit jobs, crawl admission, operational state
                              ├─ Google Search Console: server-side search-performance requests
                              └─ Common Crawl link data: bounded exact-host preview path

Audit path
  POST /api/v1/audit → durable MongoDB job → protected lease-based worker → bounded crawl
```

The application MongoDB connection and analytical/link-data connection remain separate and server-only.

## Data coverage

The completed reference data-engineering milestone is the ordered first **10,000** WAT inputs from `CC-MAIN-2026-30`.

- Raw ingestion: 10,000 / 10,000 inputs completed.
- Derived backlink layout: 10 / 10 derive shards completed.
- Derived reference inventory: 13,080 objects and 214,367,837,062 bytes.
- Detail layout: 1,024 deterministic `target_host_bucket` partitions per derive shard.

This is a verified bounded dataset, not a claim of complete Common Crawl or web coverage. Serving detail records requires both `target_host_bucket` and exact `target_host`; the request path must not scan the full graph by host alone.

The next proposed workload is a separate, non-overlapping 25,000-input window (`[10000, 35000)`). It is **prepared for a canary only** and has not been started by this repository.

## Repository layout

```text
src/                                  React dashboard
api/                                  Vercel function entrypoint
lib/                                  API, MongoDB, crawler, audit, GSC, and backlink services
tests/                                TypeScript and Python regression suites
tools/                                Common Crawl manifests, ingestion, verification, and derive tooling
deployment/common-crawl-production-v2/
                                      Proven bounded production-v2 release/runbook artifacts
deployment/common-crawl-gcp-r2-25k/  Local-only GCP → Cloudflare R2 25K canary preparation
```

## Local development

### Prerequisites

- Node.js 20.19+ and pnpm 11
- Python 3.12+ for Common Crawl tooling/tests

### Install and run

```bash
pnpm install
pnpm dev
```

The Vite application is then available through the local development URL.

### Validate

```bash
pnpm typecheck
pnpm test
pnpm build
python tests/common_crawl_wat_ingest.test.py
```

The cloud pipeline has additional focused Python tests under `tests/`. They are designed to run locally and do not require production credentials by default.

## Configuration and secrets

Copy `.env.example` to a local `.env` and populate only the services you are developing against. Never commit credentials, MongoDB URIs, cookies, OAuth tokens, AWS credentials, Cloudflare R2 credentials, or scheduler secrets.

Cloud-accessed pipeline code is designed around least-privilege, runtime-injected credentials. The GCP/R2 preparation uses Google Secret Manager as its planned secret-delivery boundary; no Cloudflare credential is embedded in source, release bundles, containers, or job specifications.

## Common Crawl pipeline status

The production-v2 code preserves deterministic manifests, immutable output keys, checksum metadata, resumability, and completion-marker-last publication. Existing artifacts remain useful as a proven reference implementation.

The next-generation preparation under `deployment/common-crawl-gcp-r2-25k/` is intentionally isolated from the completed 10K dataset. It provides:

- an immutable 25K source slice (`[10000, 35000)`) split into 25 canonical shards;
- Common Crawl public-HTTPS streaming with bounded retry/backoff and telemetry;
- Cloudflare R2 immutable publication using `growthsent-sha256` metadata and fail-closed reuse/conflict detection;
- Google Batch job specifications, container definitions, credential design, and one-WAT canary tooling;
- no cloud execution, data migration, or 25K processing by default.

Before any cloud run, follow the deployment runbooks, verify locked manifest/release hashes, and approve each canary stage explicitly.

## Engineering principles

1. **Truth over presentation.** Missing evidence is not a pass.
2. **Bounded work.** Limits, leases, timeouts, queues, and retry ceilings protect users and infrastructure.
3. **Immutable data.** Deterministic keys, verified hashes, and completion markers make interruption and resume safe.
4. **Least privilege.** Application, crawler, analytics, and object-storage access stay narrowly scoped.
5. **Canary before scale.** A new platform or input window is proven on a small, isolated workload before ramping.

## Contributing

Keep changes focused and preserve existing safety contracts. Run the relevant local tests, typecheck, build, and `git diff --check` before opening a pull request. Do not deploy, alter cloud data, or widen cloud permissions as part of ordinary code changes.

## License

No license has been declared in this repository.
