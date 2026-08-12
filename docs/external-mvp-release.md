# External MVP release preflight

This is a read-only release checklist. It does not create indexes, run an audit,
or query Common Crawl link rows.

## Required server-only Vercel Production variables

- `MONGODB_URI` and `MONGODB_DB_NAME`: operational application MongoDB only.
- `MONGODB_DATA_FEDERATION_URI` and `MONGODB_DATA_FEDERATION_DB_NAME`: Atlas
  Data Federation only. They must not be the operational URI/database.
- `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRAWL_ADMISSION_SECRET`, and
  `CRON_SECRET`: long, unique server-only values. Do not prefix any of these
  with `VITE_` or `NEXT_PUBLIC_`.
- `CRAWLER_USER_AGENT` and `NEXT_PUBLIC_APP_URL`.

Run this in a shell that has the intended Production values, before deploying:

```powershell
pnpm run preflight:production
```

The command returns JSON booleans/categories only. A nonzero exit means do not
release. It checks operational-Mongo connectivity and all manifest indexes,
confirms the Data Federation collections are reachable, and asks `$collStats`
for at most 64 metadata records per collection. It never runs a table count or
a link aggregation. Both collections must report `multiplePartitionsVisible`.

If a Data Federation collection reports zero or one partition, correct the
Atlas mapping to the production `dataset=pages/` or `dataset=links/` wildcard
prefix and run `updateCatalog` in Atlas. Do not change the app to compensate.

## Required MongoDB indexes

The preflight reports missing manifest indexes. For this hardening pass these
must include:

- `crawlJobs.crawl_jobs_job_id_unique`
- `crawlJobs.crawl_jobs_queue_due`
- `crawlJobs.crawl_jobs_lease_expiry`
- `crawlJobs.crawl_jobs_status_created_at`
- `crawlAdmission.crawl_admission_expires_at_ttl`
- `backlinkQueryProtection.backlink_query_protection_expires_at_ttl`

Index provisioning is intentionally a separate, explicit operator action: it
can create unique and TTL indexes and is therefore not part of the preflight.
Audit duplicates before creating unique indexes and obtain explicit approval
before creating TTL indexes.

## Scheduler

Configure cron-job.org manually:

- URL: `https://growthsent.com/api/v1/internal/audit-worker`
- Method: `GET`
- Frequency: every minute
- Custom header: `Authorization: Bearer <CRON_SECRET>`

The expected response is HTTP 200 with `{ "ok": true }`. Each request runs
one bounded durable-worker pass; it does not drain the queue in a loop.

After the first successful scheduler call, verify the protected health route
manually with the same header:

```powershell
curl.exe -i -H "Authorization: Bearer <CRON_SECRET>" https://growthsent.com/api/v1/internal/audit-worker/health
```

It reports only scheduler timestamps, claim state, bounded queue depth, oldest
pending age, and stale lease count. It never returns targets, users, URLs, or
secrets. Configure cron-job.org failure notifications separately.

## Local release checks

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:production-function
git diff --check
```

`smoke:production-function` imports the Vercel API entrypoint and uses the
same TypeScript release transform to prove each server runtime `ObjectId`
namespace binding is emitted. It is a deterministic local guard, not a
substitute for a deployed Vercel artifact inspection.

## Post-deployment smoke checks

1. Sign in and add one public website. Confirm `/api/v1/audit` returns 202.
2. Confirm the UI says `Queued` before a worker claims the job, then
   `Crawling pages...` and `Analyzing results...` only for those statuses.
3. Confirm a completed audit does not render TLS, Open Graph, robots, sitemap,
   or self-referential-canonical PASS claims without collected evidence.
4. Search an existing backlink domain. Confirm the preview badge, external
   link-observation wording, ten-row maximum, and unavailable aggregates use
   an em dash rather than a fabricated total.
5. Use the authenticated health endpoint to confirm worker activity and no
   accumulating stale leases. Do not expose it in the frontend.
