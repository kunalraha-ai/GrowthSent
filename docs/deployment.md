# GrowthSent — Local Development & Vercel Deployment Guide

## Local Development
1. Clone repository and install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   ```
2. Copy environment variable template:
   ```bash
   cp .env.example .env
   ```
3. Start Vite dev server with integrated API middleware:
   ```bash
   pnpm run dev
   ```
4. Access app preview at `http://localhost:8443`. API endpoints are available under `http://localhost:8443/api/v1/*`.

## Vercel Deployment
1. Use Node.js 20.19+ and pnpm 11.18.0 (declared in `package.json`), then connect the repository to Vercel.
2. Set Environment Variables in Vercel Project Settings:
   - `MONGODB_URI`
   - `MONGODB_DB_NAME`
   - `SESSION_SECRET`
   - `ENCRYPTION_KEY`
   - `NEXT_PUBLIC_APP_URL`
   - `CRON_SECRET` (a high-entropy scheduler-only secret; Production only)
3. Use MongoDB Atlas or another replica set. The application intentionally refuses unsafe standalone-Mongo fallbacks for transactional result publication and account/site deletion.
4. Configure cron-job.org as the durable worker scheduler described below. The Vercel handlers enqueue and query scan/audit jobs only; without this scheduler they remain queued.
5. Vercel automatically detects `api/v1/[...path].ts` as Serverless Functions and builds the Vite React frontend with pnpm.
6. Do not enable `PROVISION_MONGODB_INDEXES` during normal traffic. Before a controlled provisioning deployment, audit target-database duplicates and explicitly opt into unique indexes with `PROVISION_MONGODB_UNIQUE_INDEXES=true`. TTL indexes require the separate `PROVISION_MONGODB_TTL_INDEXES=true` approval because they begin expiring data.
7. `src/modules`, `src/routes`, and `src/shared` remain dormant/unmounted. Do not expose them in the Vercel API until their independent authentication and collection-compatibility work is complete.

## Audit worker scheduling with cron-job.org

The worker endpoint is server-only and protected by the Vercel Production `CRON_SECRET`. Do not put this secret in client code, source control, a query string, or a public URL.

Create one cron-job.org job with these settings:

- **URL:** `https://growthsent.com/api/v1/internal/audit-worker`
- **Method:** `GET`
- **Schedule:** every 1 minute
- **Custom request header:** `Authorization: Bearer <CRON_SECRET>`

The `<CRON_SECRET>` value must exactly match the high-entropy `CRON_SECRET` configured only in the Vercel Production environment. It is not an application session token.

Each accepted invocation runs exactly one existing `processDurableCrawlWork()` pass. That pass atomically claims at most one audit job and one legacy scan job; it never drains the queue in a loop. Existing lease, retry, and duplicate-claim protections remain responsible for safe overlap when a one-minute request arrives while a prior run is still active.

Expected successful response:

```json
{
  "ok": true,
  "auditClaimed": true,
  "scanClaimed": false
}
```

The endpoint returns HTTP `200` for a successful pass. Either `auditClaimed` or `scanClaimed` can be `false` when no due job of that type exists; that is still a healthy scheduler result. A missing or incorrect header returns HTTP `401` without executing worker code. A worker exception returns HTTP `500`, so cron-job.org can record the failed invocation and retry at the next scheduled minute.

### Safe test procedure

1. Set a new high-entropy `CRON_SECRET` in Vercel **Production** environment variables and deploy the release. Do not add it to a frontend-prefixed variable or commit it.
2. Create the cron-job.org entry with the exact URL, `GET` method, one-minute schedule, and `Authorization` header above. Keep it disabled until the controlled test is ready.
3. Queue one audit for a controlled, publicly accessible test site. Confirm its API status is `queued` in the GrowthSent UI.
4. Use cron-job.org's one-time test run while the job is enabled for that request. Confirm an HTTP `200` response and `auditClaimed: true`.
5. Confirm the audit status transitions from `Queued` to `Crawling pages...`, then `Analyzing results...`, and finally a terminal result. Repeated scheduler requests are safe because the durable lease prevents the same job from being claimed twice.
6. Enable the one-minute schedule only after that controlled result is verified. Never test by placing `CRON_SECRET` in a browser URL or an unauthenticated request.
