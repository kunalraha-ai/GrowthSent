# GrowthSent — Local Development & Vercel Deployment Guide

## Local Development
1. Clone repository and install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variable template:
   ```bash
   cp .env.example .env
   ```
3. Start Vite dev server with integrated API middleware:
   ```bash
   npm run dev
   ```
4. Access app preview at `http://localhost:8443`. API endpoints are available under `http://localhost:8443/api/v1/*`.

## Vercel Deployment
1. Connect repository to Vercel.
2. Set Environment Variables in Vercel Project Settings:
   - `MONGODB_URI`
   - `MONGODB_DB_NAME`
   - `SESSION_SECRET`
   - `ENCRYPTION_KEY`
   - `NEXT_PUBLIC_APP_URL`
3. Vercel automatically detects `api/v1/[...path].ts` as Serverless Functions and builds the Vite React frontend.
4. Deploy with `vercel --prod` or automatic Git push deployment.
