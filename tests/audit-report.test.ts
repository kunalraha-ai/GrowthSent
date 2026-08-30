import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditReportHtml } from "../src/components/dashboard/audit-report.js";

test("downloadable audit report is evidence-based and escapes website content", () => {
  const html = buildAuditReportHtml({
    scan: {
      hostname: "example.com",
      completionTime: "2026-08-30T00:00:00.000Z",
      seoScore: 72,
      crawlStats: { totalPagesCrawled: 2 },
    },
    pages: [{ url: "https://example.com/<script>", statusCode: 200, title: "<img src=x>", isNoindex: false }],
    issues: [{ severity: "high", title: "Missing <title>", affectedUrl: "https://example.com/", description: "<script>alert(1)</script>", recommendation: "Add a title." }],
  });

  assert.match(html, /72%/);
  assert.match(html, /Pages checked/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});
