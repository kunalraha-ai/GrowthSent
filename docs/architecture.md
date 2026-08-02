# GrowthSent — Backend System Architecture

## Architecture Overview
GrowthSent is built with a service-oriented modular architecture using TypeScript, Node.js, and MongoDB Atlas. It is designed to be fully Vercel-compatible with zero cold-start bottlenecks.

```
/lib
  /db           - MongoDB singleton client, collection models, TTL & unique indexes
  /security     - SSRF guard, IP range restrictions, URL normalization, HTML sanitizer
  /crawler      - SSRF-safe HTTP client, robots.txt directive parser, sitemap parser, HTML signal extractor
  /seo          - Modular rule definitions, transparent deterministic scoring engine
  /scans        - Scan job orchestrator, persistence (scans, pages, issues collections)
  /auth         - User accounts, secure HTTP-only cookies (gs_session), password hashing, OAuth abstractions
  /websites     - Authenticated website management (multi-site CRUD)
  /monitoring   - Periodic scan comparator, change snapshotting, multi-scan debouncing
  /analytics    - Privacy-friendly telemetry event collector & daily aggregate query engine
  /integrations - Integration abstractions (Google Search Console, Google Analytics), token encryption at rest
  /keywords     - Keyword data domain models & provider interface
  /notifications- Alert dispatchers
  /ratelimit    - Rate limiting abstraction (IP & User sliding window)
  /jobs         - Vercel-compatible background job runner
  /mcp & /cli   - AI coding-agent and CLI foundation services
  /admin        - Internal system metrics summary
/api
  /v1           - Vercel serverless function REST API handlers with Zod validation
```

## Key System Flow
1. **Anonymous Scan**: User enters URL on landing page -> `POST /api/v1/scans` -> SSRF validation -> Queue scan -> Crawler fetches pages and parses signals -> SEO Analysis engine runs rules -> Scan saved to MongoDB -> Frontend retrieves results via `GET /api/v1/scans/:id`.
2. **Authenticated Management**: User registers/logs in -> Session cookie issued (`gs_session`) -> Saves websites -> Enables monitoring -> Periodic background comparisons snapshot site changes.
