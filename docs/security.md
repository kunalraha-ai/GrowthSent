# GrowthSent — Security Model & Protections

## Security Architecture
1. **SSRF Guard (`lib/security/ssrf.ts`)**:
   - Strictly enforces HTTP/HTTPS protocols.
   - Prevents scanning `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254` (AWS Metadata), and `[::1]`.
   - Performs DNS resolution lookup before fetching to prevent DNS rebinding attacks.
2. **HTTP-Only Cookies (`lib/auth/session.ts`)**:
   - Authentication sessions stored in HTTP-only, SameSite=Lax, Secure cookies (`gs_session`).
   - Raw tokens are never exposed or stored plain text in MongoDB (SHA-256 hashed).
3. **Sensitive Token Encryption (`lib/integrations/google.ts`)**:
   - OAuth access and refresh tokens encrypted at rest using AES-256-GCM authenticated encryption.
4. **Rate Limiting (`lib/ratelimit/limiter.ts`)**:
   - Protects API endpoints against denial of service and automated scraping abuse.
