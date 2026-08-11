import assert from "node:assert/strict";
import test from "node:test";
import { auditProgressLabel, toAuditJobUiStatus } from "../src/components/dashboard/audit-status";

test("queued audit status is shown as queued, not crawling", () => {
  assert.equal(auditProgressLabel(true, toAuditJobUiStatus("queued")), "Queued");
});

test("running audit status uses crawl and analysis wording only for matching backend states", () => {
  assert.equal(auditProgressLabel(true, toAuditJobUiStatus("crawling")), "Crawling pages...");
  assert.equal(auditProgressLabel(true, toAuditJobUiStatus("analysing")), "Analyzing results...");
  assert.equal(auditProgressLabel(true, null), "Preparing audit...");
});
