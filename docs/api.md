# GrowthSent — REST API Specification (`/api/v1`)

All API endpoints accept and return JSON. Error responses follow a standard envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error description."
  }
}
```

## Endpoints Summary

### Scans
- `POST /api/v1/scans`
  - Input: `{ "url": "https://example.com" }`
  - Response: `{ "scanId": "...", "status": "queued", "url": "..." }`
- `GET /api/v1/scans/:id`
  - Returns scan summary, status, score, metrics.
- `GET /api/v1/scans/:id/pages`
  - Returns list of scanned page documents.
- `GET /api/v1/scans/:id/issues`
  - Returns list of detected SEO issue documents.

### Authentication
- `POST /api/v1/auth/signup` (`email`, `password`, `name?`)
- `POST /api/v1/auth/login` (`email`, `password`)
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `DELETE /api/v1/auth/account`

### Websites & Monitoring
- `POST /api/v1/websites`
- `GET /api/v1/websites`
- `GET /api/v1/websites/:id`
- `DELETE /api/v1/websites/:id`
- `POST /api/v1/websites/:id/scans`
- `GET /api/v1/websites/:id/scans`

### Privacy Analytics
- `POST /api/v1/websites/:id/analytics/collect`
  - Telemetry event ingest endpoint (pageview, session ID, referrer, user agent).
- `GET /api/v1/websites/:id/analytics?days=30`
  - Returns top pages, unique visitors, sessions, referrers, and device breakdown.

### Admin
- `GET /api/v1/admin/stats` (Requires admin role)
