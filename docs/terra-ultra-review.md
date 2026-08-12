# 1. EXECUTIVE VERDICT

**NOT SAFE FOR EXTERNAL MVP** today.

No P0 private-network SSRF, credential leak, or active cross-tenant IDOR was proven in the active Vercel API path. The application has several sound foundations: server-only MongoDB/Data Federation boundaries, durable lease-based jobs, strong private-address crawl protections, bounded Data Federation row queries, and a hard-locked Common Crawl manifest.

However, external users or a MongoDB evaluator could immediately encounter materially misleading SEO claims: audit UI checks that are fabricated rather than measured, and “Backlinks” that include a site’s own internal navigation links. The public crawl admission path is also effectively unbounded across Vercel instances, and two live crawl systems have incompatible limits despite the product being described as a bounded 25-page audit.

The largest operational risk is not the crawler’s fetch concurrency—it is accepting anonymous durable work without persistent quota, deduplication, or queue limits, then running it through a scheduler with limited visibility. The largest data risk is presenting a small sample of raw Common Crawl link observations as conventional backlink intelligence.

The Data Federation implementation is appropriately cautious about individual queries, but it is not safe for broad self-service usage without shared rate control and caching/coalescing. Its process-local cache is only an optimization, not a global protection.

The right outcome is not a rewrite. GrowthSent can become **SAFE AFTER SPECIFIC BLOCKERS** with a focused hardening pass: truthful UI labels, one supported bounded crawl path, persistent admission controls, redirect-origin enforcement, production preflight checks, and a small set of regression tests.

This review was static and read-only. I did not contact Vercel, Atlas, S3, AWS, cron-job.org, or production endpoints, so live configuration and deployed state remain explicit preflight items.

## Actual architecture reconstructed from code

```text
Browser
  │
  ├─ React/Vite SPA
  │    ├─ Dashboard audit UI / backlinks UI
  │    └─ Legacy landing scan UI
  │
  └─ /api/v1/*
       │
       ├─ Production: vercel.json → api/index.ts → lib/api/router.ts
       ├─ Local dev: Vite middleware → api/v1/[...path].ts → lib/api/router.ts
       │
       ├─ Session/auth → operational MongoDB Atlas
       │    ├─ users, sessions, websites
       │    ├─ audits/crawlJobs, scans, pages, issues
       │    ├─ integrations, analytics, monitoring state
       │    └─ durable job leases/retries
       │
       ├─ Backlinks → lib/db/data-federation.ts
       │    └─ Atlas Data Federation → S3 Pages/Links Parquet
       │
       ├─ POST /audit → durable audit queue
       ├─ POST /scans → legacy durable scan queue
       └─ GET /internal/audit-worker
            └─ cron-job.org Bearer CRON_SECRET
                 └─ one bounded audit pass + one legacy scan pass
```

Separate Common Crawl path:

```text
Locked first-1,000 WAT manifest
  → Python WAT ingestion
  → deterministic Pages / Links / metrics triplets
  → S3 production-preview prefix
  → Atlas Data Federation wildcard mappings
  → authenticated backlink API
```

Operational MongoDB and Data Federation are separated in code:

- `lib/db/mongodb.ts` uses `MONGODB_URI` / `MONGODB_DB_NAME`.
- `lib/db/data-federation.ts` requires `MONGODB_DATA_FEDERATION_URI` / `MONGODB_DATA_FEDERATION_DB_NAME`.
- They use distinct clients and database handles.

That is a real code boundary. It does not prevent an operator from accidentally assigning the same URI/database or overly broad credentials to both paths.

# 2. TOP 10 RISKS

| Rank | Risk | Severity |
|---:|---|---|
| 1 | Audit dashboard states SEO facts that were never collected or verified. | P1 |
| 2 | “Backlinks” include internal/self-links and are not conventional SEO backlinks. | P1 |
| 3 | Anonymous crawl requests can create unbounded durable work and cost. | P1 |
| 4 | Redirects can move a crawl onto another public host under the wrong robots policy. | P1 |
| 5 | Two live crawl paths violate the claimed 25-page bounded-worker model. | P1 |
| 6 | Raw multi-billion-row Data Federation queries lack shared concurrency/cost control. | P1 |
| 7 | Production readiness depends on manually verified cron, indexes, and Data Federation mapping. | P1 |
| 8 | Monitoring is enabled/promoted but has no execution path. | P1, if shown externally |
| 9 | Production Vercel function packaging is not exercised by normal local verification. | P1 |
| 10 | Future Common Crawl reruns can mix/overwrite deterministic S3 parts under one prefix. | P2 |

# 3. P0 FINDINGS

No P0 finding was proven from the active production route path.

In particular:

- No private-network SSRF bypass was demonstrated.
- No tracked credentials, MongoDB URI, AWS credential, token, or private key was found.
- No active IDOR was found in the Vercel router ownership paths.

That is not a penetration-test guarantee; it is the result of static repository review.

# 4. P1 FINDINGS

## GS-P1-01 — Audit UI fabricates SEO results

- **Subsystem:** Product correctness / frontend
- **Files/functions:** `src/components/dashboard/SeoAuditView.tsx`; `src/components/dashboard/IssuesView.tsx`; `lib/crawler/parser.ts`; `lib/services/audit.service.ts`
- **Evidence:** `SeoAuditView.tsx` always reports:
  - sitemap “well-formed”;
  - robots “no blocking disallow rules”;
  - HTTPS as “TLS 1.3” / valid SSL;
  - canonical “self-referential” when any canonical exists;
  - unique titles based only on title presence.
  
  Open Graph fields are not extracted or persisted, yet the UI derives an `og:image` result from missing fields. `IssuesView.tsx` can say “All scanned pages passed” when there is no scan result.
- **Why it matters:** An evaluator can verify that these are unsupported claims in minutes. This is materially worse than a missing feature because it produces false SEO conclusions.
- **Trigger:** Run any website audit and open the overview.
- **Likely impact:** Loss of trust; incorrect customer decisions.
- **Recommended fix:** Remove unsupported pass/fail statements. Render only persisted evidence. Show “Not evaluated” where data is not collected.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

## GS-P1-02 — “Backlinks” include internal links and raw observations

- **Subsystem:** Backlink correctness
- **Files/functions:** `lib/backlinks/service.ts` (`backlinkTargetFilter`, `fetchBacklinkRows`); `tools/common_crawl_wat_ingest.py`; `src/components/dashboard/BacklinkAnalyticsView.tsx`
- **Evidence:** The API filters only `{ crawl, target_host }`. It does not exclude `source_host === target_host`. Ingestion emits all `A@/href` observations, including site navigation/self-links, without deduplication or link-rel classification.
- **Trigger:** Search `eignex.com`; known `eignex.com → eignex.com` rows are returned.
- **Likely impact:** A site can appear to have backlinks solely because of its internal navigation.
- **Recommended fix:** Before external display, either:
  - relabel this feature as raw observed HTML link rows for an exact hostname; or
  - derive an external-link relation using registrable-domain logic.

  `source_host !== target_host` is only a stopgap; it fails for `www.example.com → example.com` and sibling subdomains.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

## GS-P1-03 — Crawl admission is not globally rate-limited or quota-controlled

- **Subsystem:** Security / cost / durable jobs
- **Files/functions:** `lib/ratelimit/limiter.ts`; `lib/api/router.ts`; `lib/services/audit.service.ts`; `lib/scans/service.ts`
- **Evidence:** The only limiter is an in-memory `Map`, applied as a generic 100 requests/IP/minute check. Both `POST /api/v1/audit` and legacy `POST /api/v1/scans` accept anonymous work. The documented scan-limit environment settings are not consumed. There is no persistent quota, target cooldown, queue cap, or pending-job dedupe.
- **Trigger:** Repeated anonymous submissions, distributed IPs, cold starts, or multiple Vercel instances.
- **Likely impact:** Crawl backlog, outbound traffic, Vercel runtime cost, MongoDB writes, and target-site load.
- **Recommended fix:** Add a persistent enqueue guard: low anonymous quota, authenticated-user quota, per-target cooldown/pending dedupe, and maximum pending queue size. Keep the existing durable lease model.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

## GS-P1-04 — Redirects can cross crawl origin and robots boundaries

- **Subsystem:** Crawler correctness / abuse prevention
- **Files/functions:** `lib/crawler/crawler.ts`; `lib/crawler/parser.ts`
- **Evidence:** The crawler fetches robots for the original hostname, but parses links relative to `fetchRes.finalUrl` after redirects. Links on a redirected public host are treated as internal and queued without verifying they belong to the original crawl host.
- **Trigger:** Crawl an attacker-controlled domain that redirects to another public site containing self-links.
- **Likely impact:** GrowthSent can recursively crawl a third-party public site under the attacker domain’s robots policy.
- **Recommended fix:** Keep an explicit origin boundary across redirects, or deliberately restart the crawl policy and robots evaluation for the final host.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

## GS-P1-05 — Two live crawl products exceed the intended bounded worker model

- **Subsystem:** Architecture / jobs / cost
- **Files/functions:** `src/App.tsx`; `lib/api/router.ts`; `lib/services/audit.service.ts`; `lib/scans/service.ts`; `lib/jobs/runner.ts`
- **Evidence:**
  - Dashboard audit: 25 pages, depth 5, concurrency 5.
  - Anonymous legacy `/scans`: 50 pages.
  - Authenticated legacy `/scans`: 150 pages.
  - Saved-site legacy scan: 200 pages.
  - The worker executes one audit job and one legacy scan job sequentially per scheduler request.
- **Trigger:** Public landing scan or saved-site scan.
- **Likely impact:** Serverless duration/capacity assumptions are false; a nominally bounded audit worker may process a large legacy job in the same invocation.
- **Recommended fix:** Choose one supported external crawl path for MVP, with one hard page and wall-clock limit. Hide or gate the other path.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

## GS-P1-06 — Data Federation search is bounded per request but not protected at system level

- **Subsystem:** Data Federation / cost / reliability
- **Files/functions:** `lib/backlinks/service.ts`; `lib/ratelimit/limiter.ts`; `lib/api/router.ts`
- **Evidence:** The API correctly uses exact `crawl` and `target_host` equality, narrow projection, a 10-row cap, and an 8-second bound. But the 60-second/100-entry cache and rate limiter are process-local. Browser caching is private only.
- **Trigger:** Twenty concurrent large-domain searches, repeated refreshes, pagination changes, or Vercel cold starts.
- **Likely impact:** Independent raw Parquet scans, increasing latency/cost, partial responses under load.
- **Recommended fix:** Use a simple shared quota plus shared cache/request coalescing for exact-domain queries. An evaluator allowlist is an acceptable temporary control.
- **Fix before external MVP:** **YES** for broad self-service access
- **Confidence:** **HIGH**

## GS-P1-07 — Production preflight is not enforced

- **Subsystem:** Configuration / deployment
- **Files/functions:** `lib/db/indexes.ts`; `api/index.ts`; `.env.example`; `docs/deployment.md`; Atlas configuration external to repo
- **Evidence:** MongoDB indexes are provisioned only when an operator flag is enabled; the repository does not verify that they exist. Data Federation mapping is not tracked or asserted in code. `.env.example` omits `CRON_SECRET`; deployment docs omit the Data Federation variables.
- **Trigger:** New deployment, missing cron secret, missing indexes, or a Data Federation mapping regression to one Parquet object.
- **Likely impact:** Queued audits never run, queue performance degrades, or backlink coverage silently collapses to a single part.
- **Recommended fix:** Add a release checklist/read-only preflight that verifies:
  - application MongoDB and Data Federation URIs are distinct and correct;
  - indexes exist;
  - `CRON_SECRET` exists server-side;
  - scheduler receives expected authenticated success;
  - Atlas mapping exposes multiple Parquet parts under the intended prefix.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH** that repository enforcement is absent; **UNKNOWN** for current live state.

## GS-P1-08 — Monitoring is promoted but never runs

- **Subsystem:** Product integrity / operations
- **Files/functions:** `lib/websites/service.ts`; `lib/monitoring/engine.ts`; `lib/jobs/runner.ts`; `src/App.tsx`; `src/components/PricingPage.tsx`
- **Evidence:** New websites default to `monitoringEnabled: true`, but `compareScansAndSnapshot` has no caller. The worker processes only audits and legacy scans. Declared monitoring/notification job types fall through to logging.
- **Trigger:** A user enables or expects monitoring.
- **Likely impact:** Product claims a feature that cannot execute.
- **Recommended fix:** Hide it or label it unavailable for MVP. Do not build a monitoring platform just for the demo.
- **Fix before external MVP:** **YES if externally represented as available**
- **Confidence:** **HIGH**

## GS-P1-09 — Production Vercel function path is not covered by normal validation

- **Subsystem:** Serverless deployment
- **Files/functions:** `vercel.json`; `api/index.ts`; `api/v1/[...path].ts`; `vite.config.ts`; `package.json`
- **Evidence:** Production routes through `api/index.ts`; local Vite middleware uses `api/v1/[...path].ts`. The wrappers differ, including dynamic versus static router import. Normal scripts run TypeScript/Vite/test checks, but do not package or smoke-test the Vercel server function.
- **Trigger:** Another TypeScript import-elision, route-wrapper, or bundling regression.
- **Likely impact:** Production-only failures like the confirmed `ObjectId` incident.
- **Recommended fix:** Add one release/CI step that packages and executes the production function entrypoint, including runtime MongoDB imports.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH**

# 5. P2 FINDINGS

## GS-P2-01 — Host normalization and pagination are semantically inconsistent

- **Subsystem:** Backlinks
- **Files/functions:** `lib/backlinks/service.ts`; `tools/common_crawl_wat_ingest.py`
- **Evidence:** Query normalization strips `www.`, while ingestion preserves hostnames from Python URL parsing. Node/browser and Python differ on Unicode IDN handling. Pagination uses `skip().limit()` without an explicit sort.
- **Why it matters:** `www`, subdomain, trailing-dot, and IDN results can be missed or misclassified. Pages are not deterministic and larger skips may do more work.
- **Recommended fix:** Describe the current lookup as exact-host only; do not promise root-domain coverage or exhaustive pagination.
- **Fix before external MVP:** **YES** for wording; **NO** for full derived normalization
- **Confidence:** **HIGH**

## GS-P2-02 — Crawler sitemap/robots semantics are bounded but incomplete

- **Subsystem:** Crawler correctness
- **Files/functions:** `lib/crawler/robots.ts`; `lib/crawler/crawler.ts`; `lib/crawler/sitemap.ts`
- **Evidence:** Robots `Sitemap:` directives are parsed but ignored. Only `/sitemap.xml` and `/sitemap_index.xml` are tried by default. At most three child sitemap URLs are followed, and child hosts are not origin-restricted.
- **Why it matters:** Product claims should not imply full robots/sitemap validation. Child sitemap fetches remain bounded and SSRF-protected, but can reach third-party public hosts.
- **Recommended fix:** Correct UI wording now; later either support advertised sitemap locations or state the limited behavior.
- **Fix before external MVP:** **YES** for truthful UI; parser completeness can wait
- **Confidence:** **HIGH**

## GS-P2-03 — Public ports and third-party sitemap requests remain available

- **Subsystem:** Crawler security
- **Files/functions:** `lib/crawler/fetcher.ts`; `lib/crawler/sitemap.ts`
- **Evidence:** Any public port is accepted; child sitemap URLs can be cross-origin.
- **Why it matters:** Not private SSRF, but it permits limited public-port probing and unwanted third-party traffic.
- **Recommended fix:** Define an allowed-port policy and a sitemap-origin policy.
- **Fix before external MVP:** **YES** if public crawling remains open
- **Confidence:** **HIGH**

## GS-P2-04 — Durable jobs recover, but scheduler health and job progress are weakly observable

- **Subsystem:** Jobs / operations
- **Files/functions:** `lib/services/audit.service.ts`; `lib/scans/service.ts`; `lib/jobs/cron-worker.ts`
- **Evidence:** Atomic claims, leases, retries, heartbeats, and transactional finalization are present. But endpoint output only reports claimed flags; job errors are heavily redacted; no queue-depth, oldest-job, scheduler-lag, or terminal-outcome signal exists.
- **Why it matters:** A scheduler outage leaves work queued without alerting. Anonymous capabilities can expire after one hour while jobs can survive longer.
- **Recommended fix:** Add safe structured lifecycle events: claim, attempt, duration, status, queue age, retry reason category. Add a scheduler failure alert and basic queue-health check.
- **Fix before external MVP:** **YES** for minimal scheduler health; dashboard can wait
- **Confidence:** **HIGH**

## GS-P2-05 — Manual indexes are a critical operational dependency

- **Subsystem:** MongoDB / jobs
- **Files/functions:** `lib/db/indexes.ts`; `api/index.ts`
- **Evidence:** Queue, lease, unique, and TTL indexes are defined but only provisioned via operator environment flags. There is no verification path.
- **Why it matters:** Missing indexes can cause queue scans, duplicate state, and poor recovery behavior.
- **Recommended fix:** Verify production indexes in release preflight.
- **Fix before external MVP:** **YES**
- **Confidence:** **MEDIUM** on live status; **HIGH** on code behavior

## GS-P2-06 — ObjectId mitigation is good, but not deployment-gated

- **Subsystem:** Serverless runtime
- **Files/functions:** `lib/db/mongodb.ts`, `lib/auth/session.ts`, `lib/auth/user.ts`, `lib/services/audit.service.ts`, `lib/scans/service.ts`, `lib/monitoring/engine.ts`
- **Evidence:** Runtime use now consistently follows `import * as mongodbDriver from "mongodb"` and `mongodbDriver.ObjectId`. A local TypeScript transform audit found no unbound runtime `ObjectId` references across reviewed API/lib modules.
- **Why it matters:** This is strong evidence, but not identical to Vercel’s packaged runtime artifact.
- **Recommended fix:** Test emitted production function code before releases.
- **Fix before external MVP:** **YES**
- **Confidence:** **HIGH** for current source; **MEDIUM** for future Vercel emission

## GS-P2-07 — Common Crawl S3 triplets are resumable but not immutable as a set

- **Subsystem:** Common Crawl pipeline integrity
- **Files/functions:** `tools/common_crawl_wat_ingest.py`; `tools/verify_common_crawl_s3_objects.py`
- **Evidence:** Deterministic object names derive from input identity. Pages, Links, and metrics are uploaded individually. Resume checks object existence plus `metrics.input`, not content/schema hashes.
- **Why it matters:** A raw non-resume invocation or changed ingestion code can overwrite/mix logical triplets under the same prefix.
- **Recommended fix:** Keep the completed preview prefix immutable. For future runs use new versioned prefixes or conditional writer locking plus hashes/schema version in metric sidecars.
- **Fix before external MVP:** **NO** for the frozen preview; **YES** before reprocessing/expanding it
- **Confidence:** **HIGH**

## GS-P2-08 — S3 verifier proves object presence, not Parquet correctness

- **Subsystem:** Data integrity
- **Files/functions:** `tools/verify_common_crawl_s3_objects.py`
- **Evidence:** Verification uses object metadata and metrics sidecar checks; it does not validate Parquet footer/schema/row counts/checksums.
- **Why it matters:** Corrupt or manually replaced data may be treated as resumably complete.
- **Recommended fix:** Add per-part hash/schema/row metadata and bounded footer verification for future datasets.
- **Fix before external MVP:** **NO** for static preview; **YES** for future pipeline releases
- **Confidence:** **HIGH**

## GS-P2-09 — Pipeline recovery documentation contradicts the control wrapper

- **Subsystem:** Common Crawl operations
- **Files/functions:** `docs/common-crawl-production-v1.md`; `deployment/common-crawl-production-v1/ssm-production-v1.ps1`
- **Evidence:** Documentation says a replacement EC2 can resume, but the SSM wrapper hard-locks a specific instance ID. The generated systemd service uses `Restart=no`.
- **Why it matters:** Algorithmic S3 resume works, but the operational control plane cannot simply target a replacement instance.
- **Recommended fix:** Correct the recovery runbook and wrapper before the next production ingestion.
- **Fix before external MVP:** **NO** for app demo; **YES** before next crawl run
- **Confidence:** **HIGH**

## GS-P2-10 — Analytics/retention and process-local caches do not scale predictably

- **Subsystem:** Application analytics / serverless
- **Files/functions:** `lib/analytics/aggregator.ts`; `lib/monitoring/engine.ts`; integration caches
- **Evidence:** Some analytics aggregate in function memory after broad `find().toArray()` style reads. Retention has no scheduler path. Several caches are process-local.
- **Why it matters:** Not a current demo blocker, but serverless instances do not share cache/retention state.
- **Recommended fix:** Bound aggregation inputs and schedule retention only when analytics traffic justifies it.
- **Fix before external MVP:** **NO**
- **Confidence:** **MEDIUM**

# 6. P3 FINDINGS

## GS-P3-01 — Dormant Express/Mongoose architecture is a future deployment footgun

- **Subsystem:** Maintainability / supply chain
- **Files/functions:** `src/modules`, `src/routes`, `src/shared`, `package.json`, `docs/deployment.md`
- **Evidence:** Dormant Express/Mongoose routes exist and include weak/unreviewed CRUD patterns, but active Vercel routing does not import them.
- **Why it matters:** Accidentally mounting that tree later could create severe authorization exposure.
- **Recommended fix:** Keep it explicitly unmounted; add a guard/test. Do not delete it in MVP hardening.
- **Fix before external MVP:** **NO**
- **Confidence:** **HIGH**

## GS-P3-02 — Baseline browser security headers are absent

- **Subsystem:** Web security
- **Files/functions:** `vercel.json`
- **Evidence:** No CSP, frame-ancestors/X-Frame-Options, HSTS, referrer policy, or permissions policy was found.
- **Why it matters:** No current XSS sink was found, but a later rendering regression has larger blast radius.
- **Recommended fix:** Add a minimal compatible header policy after MVP blockers.
- **Fix before external MVP:** **NO**
- **Confidence:** **HIGH**

## GS-P3-03 — Signup allows account enumeration

- **Subsystem:** Authentication
- **Files/functions:** `lib/auth/user.ts`; `lib/api/router.ts`
- **Evidence:** Existing email produces a thrown error/500 while a new account returns 201; timing also differs because duplicate detection happens before password hashing.
- **Why it matters:** Existing accounts can be inferred.
- **Recommended fix:** Return a consistent signup contract and separately rate-limit signup.
- **Fix before external MVP:** **NO**, unless email privacy is a launch requirement
- **Confidence:** **HIGH**

## GS-P3-04 — Legacy Common Crawl scripts and dependency files can confuse operators

- **Subsystem:** Pipeline maintainability
- **Files/functions:** root WAT scripts; `requirements-common-crawl.txt`; deployed requirements file
- **Evidence:** Multiple prototype scripts and a non-production dependency file coexist with the production-v1 deployment bundle.
- **Why it matters:** A future operator could run an obsolete pipeline.
- **Recommended fix:** Label historical/prototype paths clearly. Preserve the dictionary experiment as requested.
- **Fix before external MVP:** **NO**
- **Confidence:** **HIGH**

# 7. SECURITY REVIEW

## Authentication, sessions, and secrets

Strong evidence:

- Sessions use random 32-byte opaque tokens; only hashes are stored.
- Cookies are `HttpOnly`, `Secure` on Vercel, and `SameSite=Lax`.
- OAuth state is one-time-use and nonce-protected.
- Google tokens are encrypted with AES-256-GCM.
- Cron worker auth uses timing-safe Bearer comparison.
- No tracked `.env`, MongoDB URI, AWS credential, private key, CRON secret, or Data Federation URI was found.
- No client-side usage of server-only MongoDB/Data Federation/cron secrets was found.

Caveats:

- `.env.example` omits `CRON_SECRET`.
- There is no code-level assertion that application MongoDB and Data Federation use distinct endpoints/databases.
- No baseline security-header policy exists.

## Authorization / multi-tenancy

No active IDOR was found in the active Vercel router:

- Website reads query `_id` and `userId`.
- Saved-site audit creation validates ownership in both route and service.
- Audit status requires owner/session or a high-entropy anonymous capability.
- Legacy scan reads use access-aware checks.
- Google integration filters by `userId` and `websiteId`.
- Admin access checks role.

The main caveat is testing: the meaningful two-tenant integration test is opt-in and skipped by default.

## Injection, XSS, command execution

Static review found no active use of `eval`, shell execution, `dangerouslySetInnerHTML`, raw NoSQL operators from request payloads, or direct frontend database access in the active route path. This is not equivalent to an adversarial penetration test.

## Crawler SSRF verdict

**No P0 private-network SSRF was proven.**

The protections are substantive:

- HTTP/HTTPS only; URL credentials blocked.
- Blocks loopback, RFC1918, link-local, metadata, reserved IPv4, IPv6 local/mapped ranges, localhost/internal suffixes.
- Rejects a hostname if any DNS result is restricted.
- Revalidates every fetch and redirect.
- Pins validated DNS resolution during fetches.

The identified redirect bug is a **public-host boundary and robots-compliance issue**, not a demonstrated path to `localhost`, RFC1918, or `169.254.169.254`.

Before public crawling, still constrain public ports and sitemap-origin traversal.

# 8. DATA / BACKLINK CORRECTNESS REVIEW

GrowthSent cannot honestly present current backlink metrics as standard SEO backlink intelligence.

The current data can honestly be described as:

> A bounded sample of raw HTML anchor-link observations targeting an exact hostname, drawn from the first 1,000 WAT files of CC-MAIN-2026-30.

It cannot honestly claim:

- total backlinks;
- all referring domains;
- external backlinks;
- full root-domain/subdomain coverage;
- deduplicated referring pages;
- nofollow/sponsored/UGC support;
- canonicalized target resolution;
- redirect-resolved link counts;
- full-web coverage.

The preview-coverage badge and unavailable overview metrics are good choices. The internal-link issue defeats that otherwise honest partial-result design.

Correct MVP semantics:

1. Treat the current view as exact-host raw observed links.
2. Do not call them external backlinks until an external-domain relation exists.
3. Do not treat `www`, apex, IDN, and subdomain variants as equivalent until normalized derived fields exist.
4. Do not promise exhaustive pagination without a deterministic serving model.

# 9. DATA FEDERATION / SCALABILITY REVIEW

## Current query shape

The active rows query is comparatively safe:

- exact `crawl` and `target_host` equality;
- narrow projection;
- 10-row cap;
- approximately 8-second safety bound;
- no forced global count/group/sort work;
- partial response behavior instead of waiting indefinitely.

That is appropriate for a limited preview.

## Risks

The raw links dataset is billions of rows. The Parquet writer emits in WAT/page encounter order, not target-host order. Row-group min/max metadata can help only if files are sufficiently clustered; current ingestion does not guarantee that. Observed multi-second responses for tiny result sets are consistent with meaningful scan work.

The 60-second cache and generic limiter are process-local. They do not protect against Vercel concurrency or cold starts.

## NOW

- Keep exact-host equality filtering.
- Keep narrow projection and 10-row cap.
- Keep the 8-second bound.
- Keep partial responses explicit.
- Add shared quota/cache/coalescing.
- Use honest raw-observation wording.

## NEXT

- Create derived normalized host fields.
- Derive registrable-domain and `is_external` relation.
- Cluster/partition serving data by normalized target host.
- Materialize modest domain-level aggregates for demanded domains.
- Add Atlas mapping/part-count release validation.

## LATER

- Build a serving-oriented reverse-link/domain aggregate dataset for full Common Crawl coverage.
- Do not run interactive global group/count/rank queries over raw global Parquet.

# 10. CRAWLER / DURABLE JOB REVIEW

## Current crawler behavior

Audit path:

- hard limit: 25 pages;
- depth: approximately 5;
- fetch concurrency: 5;
- default fetch timeout: approximately 5 seconds;
- redirects: up to 5;
- robots fetched and parsed;
- default sitemap endpoints fetched;
- technical analysis occurs after crawl collection, not inline per page.

Legacy path differs materially:

- anonymous: 50 pages;
- authenticated: 150 pages;
- saved site: 200 pages.

The crawler is not serial; fetch concurrency is bounded. The danger is inconsistent entrypoints and total work, not lack of parallelism.

## Progress state

Persisted job state primarily exposes status, coarse percentage, and page count. It does not provide a complete live model of discovered URLs, queued URLs, active fetches, successful pages, and failed URLs. This makes “is it stalled?” difficult to answer from product state alone.

## Durable queue behavior

Good:

- atomic claims;
- leases;
- heartbeats;
- retry backoff;
- transactional finalization;
- stale worker fencing;
- overlapping cron calls cannot claim the same valid leased job.

Risks:

- worker death typically waits lease expiry before retry;
- scheduler outage leaves jobs queued with no alert;
- one worker invocation processes both queue types;
- anonymous capabilities can expire before delayed work becomes visible;
- no durable queue admission/dedupe.

## Frontend polling

- Dashboard audit polling is approximately 3 seconds.
- Legacy landing scan polling remains approximately 1.5 seconds.
- Polling lacks robust non-200 handling, abort/cleanup, and durable job rehydration after reload.

# 11. COMMON CRAWL PIPELINE REVIEW

The production-v1 ingestion design has several strong characteristics:

- hard first-1,000 input ceiling;
- ordered manifest hash lock;
- deterministic per-input naming;
- duplicate-input rejection;
- bounded worker choices;
- local temp-to-final Parquet behavior;
- upload-before-local-cleanup;
- metrics sidecar;
- remote resume requiring Pages/Links/metrics triplet plus input identity.

The reported metrics should be interpreted carefully:

- `records_seen`: WAT JSON payload records, not unique pages.
- `pages_emitted`: emitted page rows, not deduplicated canonical pages.
- `links_emitted`: raw anchor-link observations, not verified external backlinks.
- output bytes: Pages/Links Parquet bytes, not necessarily total S3 footprint.

The completed preview is reasonably protected operationally if treated as immutable. Future reruns need stronger logical-triplet immutability and verification.

Do not restart, rerun, redesign, benchmark, delete, or touch the dictionary optimizer as part of this work.

# 12. COST / DENIAL-OF-WALLET REVIEW

Highest-risk cost paths:

1. Anonymous durable crawl creation.
2. Legacy 50/150/200-page scan paths.
3. Repeated large-domain Data Federation searches across Vercel instances.
4. Scheduler invocation processing two different queue types.
5. Unbounded retry/backlog visibility gaps.
6. Function duration under redirects, sitemap work, analysis, and persistence.

Current protections are insufficient because they are local-process protections, not shared controls.

Before broad access, minimum controls should be:

- persistent per-IP and per-user crawl quota;
- active/pending job cap;
- target cooldown and dedupe;
- shared backlink request quota;
- shared cache/coalescing for exact domain lookup;
- queue/scheduler alerting;
- external evaluator allowlist or low usage tier while raw Data Federation remains the serving path.

A full queue platform, graph database, Kafka, or full serving-index rebuild is not necessary for MVP hardening.

# 13. FRONTEND / PRODUCT-INTEGRITY REVIEW

Main integrity concerns:

- Audit UI reports invented SEO pass/fail states.
- Backlink UI calls raw exact-host observations “Backlinks.”
- Legacy landing scan has separate behavior and faster polling.
- Anonymous jobs cannot be reliably rehydrated after long delays.
- Monitoring is externally suggested but nonfunctional.

Positive UI behaviors already present:

- Backlink preview coverage is visibly labeled.
- Backlink unavailable sections are not fabricated as numeric totals.
- Audit status wording distinguishes queued/crawling/analyzing in the newer dashboard flow.

Do not add invented charts, authority scores, traffic metrics, or “complete index” language. The strongest demo is a visibly bounded, honest technical audit plus a clearly labeled Common Crawl preview sample.

# 14. OBSERVABILITY REVIEW

Current useful elements:

- Vercel logs;
- safe structured error logging;
- backlink timing instrumentation;
- pipeline log/status/metrics artifacts;
- durable job state.

Missing minimum operational signals:

- queue depth and oldest queued job;
- scheduler last-success time;
- worker claim/outcome/duration/retry signals;
- lease-expiry/stale-job count;
- crawl phase and failure category;
- Data Federation latency, timeout, cache-hit, and partial-response rate;
- deployed release/version context;
- Atlas mapping verification result;
- production index verification result.

Recommended MVP observability:

- Keep Vercel logs.
- Add structured lifecycle logs and a small queue-health endpoint/check.
- Configure cron-job.org failure notification.
- Add one error-tracking product only if it provides actionable alerting and grouped stacks; do not add both Sentry and Datadog by default.

Never log raw credentials, cookies, tokens, full connection strings, or unnecessary crawled URLs.

# 15. TESTING GAPS

Important missing coverage:

- external-link versus internal-link backlink behavior;
- root-domain/subdomain/`www`/IDN/trailing-dot handling;
- deterministic backlink pagination;
- Data Federation partial-result/error contract;
- Atlas wildcard mapping exposes multiple parts;
- redirect-to-different-public-host crawler behavior;
- redirect-to-metadata-address regression;
- child sitemap origin policy;
- public port policy;
- persistent rate limit/queue quota/dedupe;
- concurrent worker claims, lease expiry, retry, heartbeat, crash recovery;
- production MongoDB index preflight;
- frontend polling cleanup/non-200/reload recovery;
- frontend assertions only from persisted evidence;
- Vercel-emitted server function runtime/import smoke.

Existing tests do cover useful low-level areas, but meaningful tenant integration tests are opt-in and production-function packaging is not tested.

# 16. FAILURE-SCENARIO MATRIX

| # | Scenario | Expected current behavior | Actual behavior from code | Risk | Recommended action |
|---:|---|---|---|---|---|
| 1 | Search `mongodb.com` | Bounded preview sample | Exact-host raw rows, max 10, unsorted, may timeout/partial | Can look like SEO backlink data when it is not | Honest labels; quota/cache |
| 2 | 20 large searches | Bounded shared load | Each Vercel instance can issue independent scans | Cost/latency collapse | Shared rate limit/cache |
| 3 | Repeated refresh | Cached result | Private/process-local caches are bypassable | Cost amplification | Coalesce/cache exact requests |
| 4 | Internal URL crawl | Block unsafe targets | Private addresses blocked; public redirect host can be crawled | Robots/origin bypass | Preserve origin across redirects |
| 5 | 100 audit jobs | Admission controls | Durable jobs are inserted without persistent quota/dedupe | Denial of wallet | Queue quota/cooldown |
| 6 | Cron offline 1 hour | Resume and notify | Jobs remain queued; no alert; anonymous access may expire | Silent backlog | Health alert/stale state |
| 7 | Two cron calls | No duplicate job processing | Atomic claims protect same job; distinct jobs can run concurrently | Capacity variability | Global admission/observability |
| 8 | Worker dies mid-crawl | Retry safely | Lease expires, then retry; transaction fences stale completion | Delayed recovery | Monitor lease expiry |
| 9 | Multiple cold starts | Limits remain effective | Rate/cache are per process | Bypass of controls | Shared store/control |
| 10 | MongoDB unavailable | Fail/recover visibly | Request fails; worker eventually lease/retry behavior applies | Silent job delays | Alert/retry visibility |
| 11 | Data Federation slow | Partial response | Rows can become unavailable/partial; connection failure may be 503 | Incomplete UI data | Preserve explicit partial state |
| 12 | Data Federation partial | Clearly labeled partial | API/UI already support unavailable sections | Good, but easy to regress | Contract tests |
| 13 | EC2 dies | Resume from S3 | Ingestion can resume; SSM wrapper is tied to one instance | Manual recovery | Fix runbook/wrapper before next run |
| 14 | Same manifest rerun | Idempotent | `--resume` skips good triplets; raw writer can overwrite keys | Mixed dataset semantics | Immutable future prefixes |
| 15 | Mapping points to one file | Detect before product use | App has no mapping/part-count awareness | Silent coverage regression | Release mapping check |
| 16 | User guesses another ID | Denied | Ownership/capability checks appear correct | Low current IDOR risk | Default-on tenancy tests |
| 17 | 50 MB malformed HTML | Bounded fetch | Response/body cap exists; regression coverage incomplete | Slot/memory consumption | Add end-to-end test |
| 18 | Redirect to metadata IP | Blocked | Every redirect is revalidated and DNS-pinned | No proven P0 SSRF | Keep regression test |
| 19 | ObjectId-like bundle bug | Catch before deploy | Source is fixed; Vercel bundle not tested | Production-only 500 | Package/execute function in CI |
| 20 | MongoDB evaluator search | Honest preview | Small raw sample, potentially self-links, unavailable aggregates | Immediate credibility loss | Fix semantics/labels first |

# 17. WHAT IS ALREADY WELL DESIGNED

Do not rewrite these merely for cleanliness:

- Separate operational MongoDB and Data Federation modules.
- Server-only Data Federation access.
- Exact-host Data Federation filter, narrow projection, small cap, and timeout.
- Explicit partial response behavior rather than fake global metrics.
- Session token hashing and cookie settings.
- OAuth state/nonce handling and encrypted integration tokens.
- SSRF private-address blocking, all-answer DNS validation, redirect revalidation, DNS pinning.
- Atomic durable claims, leases, heartbeats, retry backoff, and transactional finalization.
- Bounded worker-pass design rather than unbounded queue draining.
- Common Crawl hard manifest ceiling, deterministic output names, remote resume triplets, and local cleanup only after publication.

# 18. MVP LAUNCH BLOCKERS

Before sharing broadly with external users or evaluators:

- [ ] Remove fabricated audit SEO claims.
- [ ] Make backlink semantics honest: raw exact-host observations, or correctly externalize links.
- [ ] Enforce one public crawl path with a real hard page/wall-clock budget.
- [ ] Add persistent crawl admission quota, dedupe, cooldown, and queue cap.
- [ ] Preserve crawl origin/robots boundary through redirects.
- [ ] Constrain public ports and sitemap-origin behavior.
- [ ] Verify production MongoDB indexes.
- [ ] Verify `CRON_SECRET`, cron-job.org success, and scheduler health signal.
- [ ] Verify Atlas Data Federation maps multiple intended Parquet parts.
- [ ] Add production Vercel function bundle/handler smoke validation.
- [ ] Hide monitoring unless it actually runs.

# 19. FIRST 24 HOURS AFTER REVIEW

1. Stop broad external sharing; keep use limited to owner/evaluator accounts.
2. Remove or relabel unsupported audit and backlink claims.
3. Decide which crawl route is the MVP route; gate/hide the other.
4. Implement persistent crawl admission controls and target dedupe.
5. Fix redirect-origin behavior and add regressions.
6. Run read-only production preflight: cron secret, scheduler response, indexes, URI separation, multi-part mapping.
7. Add production function package/smoke verification for the Vercel entrypoint.

# 20. NEXT 7 DAYS

1. Add queue-health and scheduler-failure observability.
2. Add tests for ownership, job leases, scheduler concurrency, and crash recovery.
3. Add backlink host/IDN/internal-link contract tests.
4. Add honest partial-result API/UI tests.
5. Correct environment/deployment documentation and remove inert environment knobs.
6. Add a small shared cache/rate-control mechanism for backlink lookups.
7. Correct crawler/sitemap/robots product wording and edge-case behavior.

# 21. NEXT 30 DAYS

1. Create a derived backlink serving dataset with normalized hosts and external-link relation.
2. Cluster/partition it by normalized target host and materialize modest requested-domain aggregates.
3. Add immutable dataset-version publication and integrity metadata for future Common Crawl runs.
4. Build lightweight queue and Data Federation operational dashboards only after the core signals exist.
5. Revisit monitoring execution only if it remains a real product commitment.
6. Add production deployment/rollback runbooks and artifact smoke checks.

# 22. DO NOT BUILD YET

- A graph database.
- Full-web backlink indexing architecture.
- Full Common Crawl release processing solely to solve MVP UX.
- Kafka, Kubernetes, or a queue-platform rewrite.
- A replacement durable job system.
- A large observability stack combining multiple vendors.
- A full crawler rewrite.
- Dictionary encoding/dictionary optimizer work.
- Automatic EC2 lifecycle automation beyond the next-run recovery fix.
- Invented SEO scores, traffic metrics, authority metrics, or charts.

# 23. FINAL GO / NO-GO CHECKLIST

**Current decision: NO-GO for broad external MVP.**

Re-run this before sharing the link:

- [ ] Audit UI only presents collected/persisted evidence.
- [ ] Backlink UI cannot mislabel internal/self-links as external backlink intelligence.
- [ ] Preview scope is visible on every backlink result.
- [ ] Anonymous crawl work has persistent quota, dedupe, cooldown, and cap.
- [ ] Only one bounded crawl path is publicly reachable.
- [ ] Redirect, private IP, port, and sitemap-origin tests pass.
- [ ] Worker can be invoked only with valid `CRON_SECRET`.
- [ ] Scheduler health/last-success is visible and alerted.
- [ ] MongoDB queue/index preflight passes.
- [ ] Application MongoDB and Data Federation configuration are separately validated.
- [ ] Atlas mapping demonstrably exposes multiple intended Parquet parts.
- [ ] `mongodb.com` produces an honest bounded/partial result within the safety limit.
- [ ] Vercel production function bundle smoke passes, including MongoDB runtime imports.
- [ ] Typecheck, tests, and production build pass from the release commit.
- [ ] No secrets are tracked or emitted in logs.

No code, data, cloud resource, or configuration was changed during this review.
