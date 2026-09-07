# Repository guide

GrowthSent is a React/Vite SEO application with a separately operated Common
Crawl link-data pipeline. The web application, the data-processing tooling,
and historical campaign evidence intentionally live together, but they have
different owners and change at different rates.

## Quick orientation

| Area | Purpose | Start with |
| --- | --- | --- |
| `src/` | Dashboard UI, page views, and client-side presentation | `src/App.tsx` and `src/components/dashboard/` |
| `api/` | Vercel API entrypoint | `api/index.ts` |
| `lib/` | Server-side application logic: audits, auth, MongoDB, GSC, and API helpers | the imported module from `api/index.ts` |
| `tests/` | TypeScript and Python regression coverage | [tests/README.md](../tests/README.md) |
| `tools/` | Reusable Common Crawl and link-index Python modules | [tools/README.md](../tools/README.md) |
| `deployment/` | Reviewed cloud deployment packages and historical campaign material | [deployment/README.md](../deployment/README.md) |
| `docs/` | Durable human documentation | [docs/README.md](README.md) |
| `public/` | Static browser assets | the relevant UI import |

## Application path

The product-facing request path is deliberately small:

```text
Browser → React/Vite UI (`src/`) → Vercel API (`api/`) → application services (`lib/`)
                                                    ├─ MongoDB Atlas
                                                    └─ Google Search Console
```

The Common Crawl link index is a separate data plane. It must not be treated as
a synchronous API dependency until a serving adapter has been explicitly
implemented and verified.

```text
Verified Cloudflare R2 corpus → GCP catalog → materialize target-domain buckets
                              → compacted GCS index → future serving adapter → UI
```

## Current versus historical operational code

The active data-index package is
[`deployment/common-crawl-gcp-link-index-v1/`](../deployment/common-crawl-gcp-link-index-v1/).
It consumes the already verified 100,000-WAT R2 corpus and produces GCS
artifacts. Its entrypoints are documented in that package's README.

Other deployment directories preserve canary, capacity, recovery, and earlier
ingestion work. They are valuable provenance, but a new campaign must never be
launched by selecting the folder with the most familiar name. Check the
[deployment guide](../deployment/README.md) first.

## Important repository conventions

- Treat Common Crawl manifests, completion markers, source lists, and stored
  artifact contracts as evidence. Do not reformat, relocate, or regenerate
  them as a cleanup task.
- Run cloud operations through reviewed scripts in `deployment/`, not by
  invoking a module in `tools/` with improvised flags.
- `context.md` is a session handoff, not an application dependency. Keep it
  factual, but put reusable instructions in `docs/` or package READMEs.
- `artifacts/`, temporary bundles, cache directories, and generated cloud
  output are not source code. Do not commit them unless a package explicitly
  defines them as reviewed evidence.
- Keep UI mock data visibly labelled until the serving API is connected to a
  verified index.

## Where to make a change

| Change | Likely home |
| --- | --- |
| Dashboard layout, navigation, or visual state | `src/components/dashboard/` and `src/index.css` |
| Vercel endpoint or request validation | `api/` and the matching `lib/` service |
| Audit crawler policy or persisted audit evidence | `lib/crawl/`, `lib/audit/`, and targeted tests |
| GSC metrics or analysis | `lib/gsc/` and `tests/search-intelligence*.test.ts` |
| Link-index catalog, materialization, or compaction behaviour | `tools/common_crawl_link_index_*.py`, matching tests, and the active GCP package |
| Cloud deployment configuration | the owning `deployment/<package>/` folder |
| Long-lived engineering guidance | `docs/` or the appropriate package README |

## Before opening a pull request

Read [CONTRIBUTING.md](../CONTRIBUTING.md), run the checks relevant to the
changed subsystem, and inspect `git diff --check`. For a data-pipeline change,
run its focused Python tests in addition to the web checks.
