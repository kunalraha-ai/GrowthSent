import assert from "node:assert/strict";
import test from "node:test";
import { createAuditReportPdf } from "../src/components/dashboard/audit-report.js";

test("downloadable audit report is a PDF built from audit evidence", async () => {
  const report = await createAuditReportPdf({
    scan: {
      hostname: "example.com",
      completionTime: "2026-08-30T00:00:00.000Z",
      seoScore: 72,
      crawlStats: { totalPagesCrawled: 2 },
    },
    pages: [{ url: "https://example.com/<script>", statusCode: 200, title: "<img src=x>", isNoindex: false }],
    issues: [{ severity: "high", title: "Missing <title>", affectedUrl: "https://example.com/", description: "<script>alert(1)</script>", recommendation: "Add a title." }],
  });

  assert.equal(report.getNumberOfPages() >= 1, true);
  const bytes = new Uint8Array(report.output("arraybuffer"));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "%PDF");
});
