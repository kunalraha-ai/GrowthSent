<h1 align="center">
  <img src="public/logo-transparent.svg" width="42" alt="GrowthSent logo mark" valign="middle" />
  GrowthSent
</h1>

<p align="center">
  <strong>Simple SEO &amp; Website Analytics for Developers</strong>
</p>

<p align="center">
  <a href="https://react.dev/"><img src="https://cdn.simpleicons.org/react/61DAFB" height="24" alt="React" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://cdn.simpleicons.org/typescript/3178C6" height="24" alt="TypeScript" /></a>
  <a href="https://vite.dev/"><img src="https://cdn.simpleicons.org/vite/646CFF" height="24" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://cdn.simpleicons.org/tailwindcss/06B6D4" height="24" alt="Tailwind CSS" /></a>
  <a href="https://www.mongodb.com/"><img src="https://cdn.simpleicons.org/mongodb/47A248" height="24" alt="MongoDB" /></a>
  <a href="https://vercel.com/"><img src="https://cdn.simpleicons.org/vercel/000000" height="24" alt="Vercel" /></a>
  <a href="https://www.cloudflare.com/"><img src="https://cdn.simpleicons.org/cloudflare/F38020" height="24" alt="Cloudflare" /></a>
  <a href="https://cloud.google.com/"><img src="https://cdn.simpleicons.org/googlecloud/4285F4" height="24" alt="Google Cloud" /></a>
</p>

GrowthSent is a bounded, evidence-first SEO and search-intelligence application. It helps teams run technical audits, examine verified Google Search Console performance, and explore a clearly labelled Common Crawl link-observation preview.

It is deliberately designed to be credible before it is expansive: an audit only reports checks supported by collected evidence, and link data is never presented as a complete commercial backlink index.

## Start here

- New to the repository: [repository guide](docs/repository-guide.md)
- Current corpus and index state: [project status](docs/project-status.md)
- Application and data boundaries: [architecture](docs/architecture.md)
- Active data-pipeline operator path: [GCP link-index v1](deployment/common-crawl-gcp-link-index-v1/README.md)
- All deployment packages: [deployment guide](deployment/README.md)
- Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Full documentation map: [docs/README.md](docs/README.md)

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

```mermaid
flowchart TB
  Browser[Browser] --> Web[React + Vite dashboard]
  Web --> API[Vercel API / application router]
  API --> Mongo[(MongoDB Atlas<br/>users, audits, leases, state)]
  API --> GSC[Google Search Console<br/>server-side queries]

  subgraph DataPlane[Verified Common Crawl link-index pipeline]
    Operator[Operator in Ubuntu / WSL] --> Launcher[Reviewed GCP launcher]
    Launcher --> SecretManager[Google Secret Manager<br/>read-only R2 child credential]
    R2Corpus[(Cloudflare R2<br/>verified 100K source corpus)] --> Catalog[Catalog job]
    SecretManager --> Catalog
    Catalog --> CatalogGCS[(Private GCS<br/>100K artifact catalog)]
    CatalogGCS --> Materialize[Materialize target-domain buckets]
    Materialize --> IndexGCS[(Private GCS<br/>materialized link index)]
    IndexGCS --> Compact[Compaction]
    Compact --> ServingGCS[(Future serving-index layout)]
  end

  ServingGCS -. future verified read adapter .-> API
```

The application and data planes are deliberately separate. The public app uses
MongoDB and Google Search Console through server-side APIs. The verified
Common Crawl corpus is read only to the GCP index pipeline, and no UI claim is
served from that index until a verified read adapter is implemented.

## Pipeline status

The `CC-MAIN-2026-30` source campaign is complete: all 100,000 locked WAT
source identities have verified immutable completion evidence. The source corpus
must be treated as read-only; do not relaunch a historical Cloudflare campaign
for this dataset.

The current work is GCP link-index materialization:

- The GCS catalog has been verified with exactly 100,000 distinct source
  identities and link artifacts.
- A bounded 1,000-source materialization cost probe is the next gate before
  full production materialization and compaction.
- Dashboard link-intelligence views are currently UI work only. They are not
  connected to live materialized index data until a serving adapter and its
  contract tests exist.

See [project status](docs/project-status.md) for the durable phase-by-phase
record and [the active GCP package](deployment/common-crawl-gcp-link-index-v1/README.md)
for reviewed operator instructions.

## Repository layout

```text
src/                                  React dashboard
api/                                  Vercel function entrypoint
lib/                                  API, MongoDB, crawler, audit, GSC, and backlink services
tests/                                TypeScript and Python regression suites
tools/                                Common Crawl manifests, ingestion, verification, and derive tooling
docs/                                 Architecture, operations, status, and product documentation
deployment/common-crawl-gcp-link-index-v1/
                                      Active verified-R2 → GCS link-index pipeline
deployment/common-crawl-production-v2/
                                      Historical production-v2 release/runbook artifacts
deployment/common-crawl-gcp-r2-25k/  Local-only GCP → Cloudflare R2 25K canary preparation
deployment/common-crawl-cloudflare-r2-10-wat-canary/
                                      Reusable one-container, ten-WAT Cloudflare canary
deployment/common-crawl-cloudflare-r2-50-wat-canary/
                                      Five-shard baseline, verification, and Worker retirement helpers
deployment/common-crawl-cloudflare-r2-standard1-regional-ramp/
                                      Self-contained regional standard-1 capacity and recovery runner
deployment/common-crawl-cloudflare-r2-standard1-hundred-thousand-self-recovery/
                                      Historical final 89K recovery control plane supporting the 100K corpus
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

The cloud pipeline has additional focused Python tests under `tests/`. They are designed to run locally and do not require production credentials by default. See the [test guide](tests/README.md) for conventions and examples.

## Configuration and secrets

Copy `.env.example` to a local `.env` and populate only the services you are developing against. Never commit credentials, MongoDB URIs, cookies, OAuth tokens, AWS credentials, Cloudflare R2 credentials, or scheduler secrets.

Cloud-accessed pipeline code is designed around least-privilege, runtime-injected credentials. The GCP/R2 preparation uses Google Secret Manager as its planned secret-delivery boundary. Cloudflare parent API tokens are accepted only locally through hidden stdin prompts; they are never embedded in source, release bundles, Worker configuration, containers, R2, logs, or command arguments. Cloudflare Workers receive only short-lived child R2 credentials scoped to one fresh canary prefix.

Turnstile protects login and signup when configured. `VITE_TURNSTILE_SITE_KEY` is a public browser-side site key; `TURNSTILE_SECRET_KEY` is server-only and belongs in the Vercel environment, never in source control.

## Historical Cloudflare canary runbook

The WSL-native canary workflow below is retained for approved new scopes and
historical context. It is not the operator path for the completed 100K corpus:

1. Prepare or reuse a local semantic-v2 baseline for an exact ten-WAT input set.
2. Publish the baseline to an isolated R2 audit prefix with its completion marker written last.
3. Run the reviewed launcher with an explicit approval flag. It verifies the baseline, mints a short-lived child R2 credential, and deploys one temporary Worker/Container pair.
4. The Container reads one WAT at a time over public HTTPS, validates semantic digests before publishing, and writes Pages, Links, metrics, and per-WAT completion objects to a fresh canary prefix.
5. Use the read-only verifier to check exact keys, SHA-256 metadata, full JSON hashes, semantic results, and completion-marker ordering.
6. Retire the temporary Worker only after verification. Do not remove immutable R2 output as part of routine cleanup.

Run Cloudflare deployment scripts only from Ubuntu/WSL with Docker available. They require a deliberate approval flag and never accept secrets as command-line arguments.

## Engineering principles

1. **Truth over presentation.** Missing evidence is not a pass.
2. **Bounded work.** Limits, leases, timeouts, queues, and retry ceilings protect users and infrastructure.
3. **Immutable data.** Deterministic keys, verified hashes, and completion markers make interruption and resume safe.
4. **Least privilege.** Application, crawler, analytics, and object-storage access stay narrowly scoped.
5. **Canary before scale.** A new platform or input window is proven on a small, isolated workload before ramping.

## Contributing

Keep changes focused and preserve existing safety contracts. Run the relevant local tests, typecheck, build, and `git diff --check` before opening a pull request. Do not deploy, alter cloud data, or widen cloud permissions as part of ordinary code changes.

## License

GrowthSent is licensed under the [Apache License 2.0](LICENSE). Contributions
submitted for inclusion are covered by that license unless the contributor
explicitly states otherwise. Third-party dependencies and external Common Crawl
data remain subject to their own licenses and terms.

## Open-source community

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
