import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { fetchUrl, readBodyWithLimit } from "../lib/crawler/fetcher";
import { parsePageHtml } from "../lib/crawler/parser";
import type { CrawlExecutionResult } from "../lib/crawler/crawler";
import { analyzeCrawlResults } from "../lib/seo/engine";
import { isBlockedIp, validateUrlForScan } from "../lib/security/ssrf";

test("SSRF validation rejects private, reserved, IPv6-mapped, and credential URLs without a network request", async () => {
  const blockedUrls = [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.0.2.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://2130706433/",
    "https://user:password@example.com/",
  ];

  for (const url of blockedUrls) {
    const result = await validateUrlForScan(url);
    assert.equal(result.isValid, false, `Expected ${url} to be blocked`);
  }

  // A public literal requires no external DNS lookup and is never fetched here.
  const publicResult = await validateUrlForScan("https://8.8.8.8/path#fragment");
  assert.equal(publicResult.isValid, true);
  assert.equal(publicResult.normalizedUrl, "https://8.8.8.8/path");

  for (const reservedIp of ["192.31.196.1", "192.52.193.1", "192.88.99.1", "192.175.48.1"]) {
    assert.equal(isBlockedIp(reservedIp), true, `Expected ${reservedIp} to be blocked`);
  }
});

test("fetchUrl rejects a private target before opening a request", async () => {
  const result = await fetchUrl("http://127.0.0.1:9/", { timeoutMs: 50 });

  assert.equal(result.statusCode, 0);
  assert.equal(result.error, "URL was blocked by the crawler safety policy.");
});

test("response buffering stops once the configured byte limit is crossed", async () => {
  const source = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);
  const result = await readBodyWithLimit(source, 8);

  assert.equal(result.exceeded, true);
  assert.equal(result.body, undefined);
  assert.equal(result.pageSizeBytes, 9);
});

test("parser preserves the page title and invalid canonicals become SEO findings", () => {
  const parsed = parsePageHtml(
    '<html><head><title>Customer Pricing Page | Example</title><link rel="canonical" href="http://[bad" /></head><body><h1>Pricing</h1></body></html>',
    "https://example.com/pricing"
  );

  assert.equal(parsed.title, "Customer Pricing Page | Example");
  assert.equal(parsed.canonicalUrl, undefined);
  assert.equal(parsed.canonicalError, "Canonical URL is malformed.");

  const crawl: CrawlExecutionResult = {
    startUrl: "https://example.com",
    hostname: "example.com",
    durationMs: 1,
    totalPagesCrawled: 1,
    bytesDownloaded: 1,
    statusCodesCount: { "200": 1 },
    robots: {
      exists: true,
      accessible: true,
      statusCode: 200,
      sitemaps: [],
      disallowedPaths: [],
      allowedPaths: [],
      rawText: "",
    },
    sitemap: {
      exists: true,
      accessible: true,
      statusCode: 200,
      urls: [],
      sitemapIndexUrls: [],
      errors: [],
    },
    pages: [{
      url: "https://example.com/pricing",
      normalizedUrl: "https://example.com/pricing",
      statusCode: 200,
      responseTimeMs: 1,
      contentType: "text/html",
      pageSizeBytes: 1,
      parsedData: parsed,
      hasRobotsTxtDisallow: false,
    }],
  };

  const analysis = analyzeCrawlResults(crawl);
  assert.ok(analysis.issues.some((issue) => issue.ruleId === "canonical-invalid"));
});

test("parser drops credential-bearing URLs and bounds extracted link data", () => {
  const links = Array.from({ length: 2_100 }, (_, index) => `<a href="/page-${index}">x</a>`).join("");
  const parsed = parsePageHtml(
    `<html><head>
      <link rel="canonical" href="https://user:password@example.com/canonical" />
      <link rel="alternate" hreflang="en" href="https://user:password@example.com/en" />
    </head><body>
      <a href="https://user:password@example.com/private">private</a>${links}
    </body></html>`,
    "https://example.com/"
  );

  assert.equal(parsed.canonicalUrl, undefined);
  assert.equal(parsed.canonicalError, "Canonical URL must not contain credentials.");
  assert.equal(parsed.hreflangs.en, undefined);
  assert.ok(parsed.internalLinks.length <= 2_000);
  assert.equal(parsed.internalLinks.some((link) => link.includes("user:password@")), false);
});
