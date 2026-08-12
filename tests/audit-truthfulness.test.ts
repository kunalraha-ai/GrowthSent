import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditMetrics } from "../src/components/dashboard/SeoAuditView.js";

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
