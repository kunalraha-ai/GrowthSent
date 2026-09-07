# GrowthSent architecture

GrowthSent has two intentionally separate planes:

1. A product application for audits, account management, and Google Search
   Console insights.
2. An offline Common Crawl link-index pipeline that creates evidence-bearing
   data artifacts before any product endpoint may serve them.

## Product application

```text
Browser → React/Vite dashboard (`src/`)
        → Vercel API (`api/v1/[...path].ts`)
        → domain services (`lib/`)
        → MongoDB Atlas / Google Search Console
```

The API layer owns input validation, authentication, authorization, and the
request boundary. `lib/` owns application domains and infrastructure helpers:

| Directory | Responsibility |
| --- | --- |
| `lib/db` | MongoDB client, collections, indexes, and transactions |
| `lib/security` | SSRF guards, URL normalization, sanitization, and security helpers |
| `lib/crawler`, `lib/scans`, `lib/audits`, `lib/seo` | Bounded crawl orchestration and evidence-based audit analysis |
| `lib/auth`, `lib/websites`, `lib/monitoring`, `lib/jobs` | Accounts, site management, durable work, and monitoring |
| `lib/integrations`, `lib/analytics`, `lib/keywords` | GSC/provider integrations and analytics domains |
| `lib/backlinks` | Product-facing backlink contracts; it must not imply coverage beyond verified source data |
| `lib/api`, `lib/services`, `lib/domain` | Shared API, service, and domain abstractions |

## Audit flow

1. A browser requests `POST /api/v1/scans`.
2. The API validates the request and queues bounded durable work.
3. The crawler collects only permitted evidence; the SEO rules evaluate that
   evidence without inventing unavailable signals.
4. Results are persisted to MongoDB and retrieved through the authenticated or
   capability-protected API.

See [API documentation](api.md), [crawler behaviour](crawler.md), and
[security guidance](security.md) for the detailed contracts.

## Link-index data plane

```text
Verified Cloudflare R2 link artifacts
  → exact GCS catalog
  → target-domain materialization
  → compaction
  → future read-only serving adapter
  → product API
```

This is deliberately not a browser-to-R2 query path. The source corpus is
immutable and the GCP pipeline receives only a scoped read credential. The
serving adapter remains a distinct future boundary; mock dashboard views must
not be presented as live index responses before that boundary is implemented
and verified.

The current pipeline and its launch gates are documented in the
[GCP link-index package](../deployment/common-crawl-gcp-link-index-v1/README.md).
For phase status, read [project status](project-status.md).

## Architectural invariants

- Missing crawl evidence is not a passing SEO finding.
- User-controlled URLs and network destinations are validated at the server
  boundary.
- Long-running crawl work is bounded, leased, and retry-limited.
- Source completion and pipeline recovery are based on immutable identities and
  contracts, not best-effort counters.
- Cloud parent credentials never enter source code, bundle artifacts, browser
  code, or remote workloads.
