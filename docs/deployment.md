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
3. Use MongoDB Atlas or another replica set. The application intentionally refuses unsafe standalone-Mongo fallbacks for transactional result publication and account/site deletion.
4. Deploy a durable worker or scheduler outside the Vercel web-request lifecycle to call `processDurableCrawlWork()` from `lib/jobs/runner.ts`. The Vercel handlers enqueue and query scan/audit jobs only; without this worker they remain queued.
5. Vercel automatically detects `api/v1/[...path].ts` as Serverless Functions and builds the Vite React frontend with pnpm.
6. Do not enable `PROVISION_MONGODB_INDEXES` during normal traffic. Before a controlled provisioning deployment, audit target-database duplicates and explicitly opt into unique indexes with `PROVISION_MONGODB_UNIQUE_INDEXES=true`. TTL indexes require the separate `PROVISION_MONGODB_TTL_INDEXES=true` approval because they begin expiring data.
7. `src/modules`, `src/routes`, and `src/shared` remain dormant/unmounted. Do not expose them in the Vercel API until their independent authentication and collection-compatibility work is complete.
