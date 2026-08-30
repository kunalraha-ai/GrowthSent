import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "bson";
import { buildPublicAuditReport } from "../lib/audits/public-report";
import type { IssueDocument, PageDocument, ScanDocument } from "../lib/db/types";

test("shared audit reports omit ownership, database, lease, and sharing capability fields", () => {
  const scanId = new ObjectId();
  const websiteId = new ObjectId();
  const timestamp = new Date("2026-08-30T00:00:00.000Z");
  const scan: ScanDocument = {
    _id: scanId,
    websiteId,
    ownerUserId: new ObjectId(),
    anonymousAccessTokenHash: "must-not-leak",
    shareTokenHash: "must-not-leak",
    leaseId: "must-not-leak",
    url: "https://example.com/",
    hostname: "example.com",
    startTime: timestamp,
    completionTime: timestamp,
    status: "completed",
    crawlStats: { totalPagesCrawled: 1, totalDurationMs: 120, bytesDownloaded: 300, statusCodesCount: { "200": 1 }, provider: "live" },
    summaryMetrics: { totalChecks: 4, passedChecks: 3, failedChecks: 1, criticalIssues: 0, highIssues: 1, mediumIssues: 0, lowIssues: 0, infoIssues: 0 },
    seoScore: 78,
    ruleVersion: "1.0.0",
    scoreVersion: "1.0.0",
    createdAt: timestamp,
  };
  const page: PageDocument = {
    _id: new ObjectId(),
    scanId,
    websiteId,
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    statusCode: 200,
    responseTimeMs: 42,
    pageSizeBytes: 300,
    headings: { h1: ["Example"], h2Count: 0, h3Count: 0 },
    isNoindex: false,
    isNofollow: false,
    hasRobotsTxtDisallow: false,
    structuredDataTypes: [],
    internalLinks: [],
    externalLinks: [],
    hreflangs: {},
    createdAt: timestamp,
  };
  const issue: IssueDocument = {
    _id: new ObjectId(),
    scanId,
    websiteId,
    ruleId: "missing_meta_description",
    category: "metadata",
    severity: "high",
    title: "Missing meta description",
    description: "The page has no meta description.",
    explanation: "Search previews may be less descriptive.",
    affectedUrl: "https://example.com/",
    recommendation: "Add a concise meta description.",
    createdAt: timestamp,
  };

  const report = buildPublicAuditReport(scan, [page], [issue]);
  assert.equal(report.scan.hostname, "example.com");
  assert.equal(report.pages[0].url, "https://example.com/");
  assert.equal(report.issues[0].ruleId, "missing_meta_description");
  const serialized = JSON.stringify(report);
  for (const forbidden of [scanId.toHexString(), websiteId.toHexString(), "must-not-leak", "ownerUserId", "shareTokenHash", "leaseId", "_id"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
