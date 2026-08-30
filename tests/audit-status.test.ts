import assert from "node:assert/strict";
import test from "node:test";
import { auditProgressDescription, auditProgressLabel, toAuditProgress } from "../src/components/dashboard/audit-status.js";

test("audit UI distinguishes queued work from crawling work", () => {
  assert.equal(auditProgressLabel(true, "queued"), "Starting audit...");
  assert.equal(auditProgressLabel(true, "crawling"), "Crawling pages...");
  assert.equal(auditProgressLabel(true, "analysing"), "Analyzing results...");
});

test("audit UI progress reports the actual crawl evidence available", () => {
  const crawling = toAuditProgress({ status: "crawling", progressPercent: 34.7, pagesCrawled: 2 });
  assert.deepEqual(crawling, { status: "crawling", progressPercent: 35, pagesCrawled: 2 });
  assert.deepEqual(auditProgressDescription(crawling), {
    title: "Checking public pages",
    detail: "2 public URLs checked so far.",
  });

  const malformed = toAuditProgress({ status: "unknown", progressPercent: -1, pagesCrawled: "two" });
  assert.deepEqual(malformed, { status: null, progressPercent: 0, pagesCrawled: 0 });
});
