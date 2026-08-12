import assert from "node:assert/strict";
import test from "node:test";
import { auditProgressLabel } from "../src/components/dashboard/audit-status.js";

test("audit UI distinguishes queued work from crawling work", () => {
  assert.equal(auditProgressLabel(true, "queued"), "Queued");
  assert.equal(auditProgressLabel(true, "crawling"), "Crawling pages...");
  assert.equal(auditProgressLabel(true, "analysing"), "Analyzing results...");
});
