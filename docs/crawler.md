# GrowthSent — Website Crawler Documentation

## Crawler Behavior & Standards
The GrowthSent crawler is designed to be lightweight, respectful, and safe:

1. **User-Agent**: `GrowthSentBot/1.0 (+https://growthsent.com)`
2. **SSRF Guard**:
   - Every target URL and discovered link is checked against DNS lookup and private IP filters before connection.
   - Prevents scanning `localhost`, `127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`, etc.
3. **Robots & Sitemaps**:
   - Automatically fetches `/robots.txt` and respects `Disallow` rules for `GrowthSentBot` and `*`.
   - Discovers `/sitemap.xml` and `/sitemap_index.xml` to discover indexable site pages.
4. **Limits**:
   - Maximum pages per anonymous scan: 50 pages.
   - Maximum crawl depth: 5 levels.
   - Maximum response body size: 2 MB.
   - Request timeout: 10,000 ms.
   - Max redirects: 5 hops.
