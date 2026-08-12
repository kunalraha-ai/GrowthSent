import assert from "node:assert";
import { analyzeCrawlResults } from "../lib/seo/engine";
import { calculateSeoScore } from "../lib/seo/scoring";
import { CrawlExecutionResult } from "../lib/crawler/crawler";

function testSeoEngine() {
  console.log("Running SEO Engine & Scoring Tests...");

  const mockCrawl: CrawlExecutionResult = {
    startUrl: "https://example.com",
    hostname: "example.com",
    durationMs: 1200,
    totalPagesCrawled: 2,
    bytesDownloaded: 15000,
    statusCodesCount: { "200": 2 },
    robots: {
      exists: true,
      accessible: true,
      statusCode: 200,
      sitemaps: ["https://example.com/sitemap.xml"],
      disallowedPaths: [],
      allowedPaths: [],
      rawText: "User-agent: *\nDisallow:",
    },
    sitemap: {
      exists: true,
      accessible: true,
      statusCode: 200,
      urls: ["https://example.com/", "https://example.com/pricing"],
      sitemapIndexUrls: [],
      errors: [],
    },
    pages: [
      {
        url: "https://example.com/",
        normalizedUrl: "https://example.com/",
        statusCode: 200,
        responseTimeMs: 300,
        contentType: "text/html",
        pageSizeBytes: 5000,
        hasRobotsTxtDisallow: false,
        parsedData: {
          title: "Valid Homepage Title for Testing Purpose",
          metaDescription: "This is a valid meta description for testing the SEO engine rules clean execution.",
          canonicalUrl: "https://example.com/",
          headings: { h1: ["Welcome to Example"], h2Count: 2, h3Count: 0 },
          isNoindex: false,
          isNofollow: false,
          structuredDataTypes: ["JSON-LD"],
          internalLinks: ["https://example.com/pricing"],
          externalLinks: [],
          hreflangs: {},
          jsonLdSyntaxValid: true,
        },
      },
      {
        url: "https://example.com/pricing",
        normalizedUrl: "https://example.com/pricing",
        statusCode: 200,
        responseTimeMs: 250,
        contentType: "text/html",
        pageSizeBytes: 4000,
        hasRobotsTxtDisallow: false,
        parsedData: {
          title: undefined, // Missing title
          metaDescription: undefined, // Missing meta description
          canonicalUrl: undefined, // Missing canonical
          headings: { h1: [], h2Count: 0, h3Count: 0 }, // Missing H1
          isNoindex: true, // Noindex detected
          isNofollow: false,
          structuredDataTypes: [],
          internalLinks: [],
          externalLinks: [],
          hreflangs: {},
          jsonLdSyntaxValid: true,
        },
      },
    ],
  };

  const analysis = analyzeCrawlResults(mockCrawl);

  assert.ok(analysis.issues.length >= 4, "Should flag missing title, missing description, missing canonical, and noindex");
  assert.ok(analysis.scoring.score < 100, "Score should drop when issues are present");
  assert.strictEqual(analysis.scoring.scoreVersion, "1.0.0");

  const uncertainDiscovery = analyzeCrawlResults({
    ...mockCrawl,
    robots: { ...mockCrawl.robots, exists: false, accessible: false, statusCode: 0 },
    sitemap: { ...mockCrawl.sitemap, exists: false, accessible: false, statusCode: 0, missingConfirmed: false },
  });
  assert.equal(uncertainDiscovery.issues.some((issue) => issue.ruleId === "robots-txt-missing"), false);
  assert.equal(uncertainDiscovery.issues.some((issue) => issue.ruleId === "sitemap-missing"), false);

  console.log(`✔ SEO Engine Tests Passed! Calculated Score: ${analysis.scoring.score}% (${analysis.issues.length} issues detected)`);
}

testSeoEngine();
