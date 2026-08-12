import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditMetrics } from "../src/components/dashboard/SeoAuditView.js";
import { isAuditResultEvaluable } from "../src/components/dashboard/audit-evidence.js";
import { pageIndexingLabel } from "../src/components/dashboard/PagesView.js";

test("audit metrics never turn absent robots, sitemap, TLS, or Open Graph evidence into a pass", () => {
  const metrics = buildAuditMetrics({
    scan: { crawlStats: { totalPagesCrawled: 1 } },
    pages: [{ statusCode: 200, title: "Example", metaDescription: "Description", headings: { h1: ["Heading"] } }],
    issues: [],
  }, "example.com");
  const unsupported = metrics.filter((metric) => /robots|sitemap|tls|ssl|open graph|og:image/i.test(`${metric.label} ${metric.detail}`));
  assert.equal(unsupported.length, 0);
  assert.equal(metrics.find((metric) => metric.id === "canonical")?.status, "warn");
  assert.match(metrics.find((metric) => metric.id === "canonical")?.detail || "", /does not infer/i);
});

test("a failed root fetch cannot render indexing, pass metrics, or an SEO result", () => {
  const failedResult = {
    scan: { url: "https://example.com/", seoScore: 85, crawlStats: { totalPagesCrawled: 1 } },
    pages: [{
      url: "https://example.com/",
      statusCode: 0,
      responseTimeMs: 2,
      fetchFailureCategory: "network",
      isNoindex: false,
    }],
    issues: [],
  };

  const metrics = buildAuditMetrics(failedResult, "example.com");
  assert.equal(isAuditResultEvaluable(failedResult), false);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, "fail");
  assert.match(metrics[0].label, /could not be evaluated/i);
  assert.equal(pageIndexingLabel(failedResult.pages[0]), "Could not evaluate");
});
