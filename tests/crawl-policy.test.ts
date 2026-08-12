import assert from "node:assert/strict";
import test from "node:test";
import { isUrlWithinCrawlOriginScope } from "../lib/domain/registrable.js";
import { isSitemapUrlWithinAuditedScope } from "../lib/crawler/sitemap.js";
import { validateUrlForScan } from "../lib/security/ssrf.js";

test("crawl scope allows same-host and www/apex redirects but not unrelated or sibling hosts", () => {
  assert.equal(isUrlWithinCrawlOriginScope("https://example.com", "https://example.com/about"), true);
  assert.equal(isUrlWithinCrawlOriginScope("https://example.com", "https://www.example.com/about"), true);
  assert.equal(isUrlWithinCrawlOriginScope("https://www.example.com", "https://example.com/about"), true);
  assert.equal(isUrlWithinCrawlOriginScope("https://example.com", "https://docs.example.com/about"), false);
  assert.equal(isUrlWithinCrawlOriginScope("https://example.com", "https://other.example/about"), false);
});

test("sitemap discovery cannot expand to a sibling or unrelated origin", () => {
  assert.equal(isSitemapUrlWithinAuditedScope("https://example.com", "https://www.example.com/sitemap.xml"), true);
  assert.equal(isSitemapUrlWithinAuditedScope("https://example.com", "https://docs.example.com/sitemap.xml"), false);
  assert.equal(isSitemapUrlWithinAuditedScope("https://example.com", "https://other.example/sitemap.xml"), false);
});

test("crawler URL validation rejects non-standard public ports before DNS resolution", async () => {
  const result = await validateUrlForScan("https://8.8.8.8:8443/");
  assert.equal(result.isValid, false);
  assert.match(result.reason || "", /standard HTTP and HTTPS ports/i);
});
