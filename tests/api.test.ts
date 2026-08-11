import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../lib/db/mongodb";
import type { CrawlJobDocument, ScanDocument, WebsiteDocument } from "../lib/db/types";
import { getScanByIdForAccess } from "../lib/scans/service";
import { createOpaqueAccessToken, hashOpaqueAccessToken } from "../lib/security/access-token";
import { AuditService } from "../lib/services/audit.service";

/**
 * API integration tests are intentionally opt-in. The legacy test previously
 * used whichever MONGODB_URI happened to be present and started real crawls,
 * which made a local test command capable of writing production data.
 */
export function assertIsolatedMongoIntegrationEnvironment(env = process.env): void {
  if (env.RUN_MONGODB_INTEGRATION_TESTS !== "1") {
    throw new Error("MongoDB integration tests require RUN_MONGODB_INTEGRATION_TESTS=1.");
  }

  if (env.NODE_ENV !== "test") {
    throw new Error("MongoDB integration tests require NODE_ENV=test.");
  }

  const databaseName = env.MONGODB_DB_NAME?.trim() || "";
  if (!/(^|[_-])test$/i.test(databaseName)) {
    throw new Error("MongoDB integration tests require a database name ending in _test or -test.");
  }

  if (!env.MONGODB_URI?.trim()) {
    throw new Error("MongoDB integration tests require an explicit MONGODB_URI.");
  }
}

test("MongoDB integration tests are opt-in and reject non-test configuration", () => {
  assert.throws(
    () => assertIsolatedMongoIntegrationEnvironment({}),
    /RUN_MONGODB_INTEGRATION_TESTS=1/
  );
  assert.throws(
    () =>
      assertIsolatedMongoIntegrationEnvironment({
        RUN_MONGODB_INTEGRATION_TESTS: "1",
        NODE_ENV: "production",
        MONGODB_DB_NAME: "GrowthSent",
        MONGODB_URI: "mongodb://example.invalid",
      }),
    /NODE_ENV=test/
  );
  assert.doesNotThrow(() =>
    assertIsolatedMongoIntegrationEnvironment({
      RUN_MONGODB_INTEGRATION_TESTS: "1",
      NODE_ENV: "test",
      MONGODB_DB_NAME: "growthsent_test",
      MONGODB_URI: "mongodb://example.invalid",
    })
  );
});

const runMongoIntegrationTests = process.env.RUN_MONGODB_INTEGRATION_TESTS === "1";

function fixtureScan(now: Date, websiteId?: ObjectId): ScanDocument {
  return {
    websiteId,
    url: "https://example.test/",
    hostname: "example.test",
    startTime: now,
    status: "queued",
    crawlStats: { totalPagesCrawled: 0, totalDurationMs: 0, bytesDownloaded: 0, statusCodesCount: {} },
    summaryMetrics: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      criticalIssues: 0,
      highIssues: 0,
      mediumIssues: 0,
      lowIssues: 0,
      infoIssues: 0,
    },
    seoScore: 0,
    ruleVersion: "1.0.0",
    scoreVersion: "1.0.0",
    createdAt: now,
  };
}

test(
  "two-tenant Common Crawl-backed scan and audit access fails closed without a matching owner or opaque capability",
  { skip: !runMongoIntegrationTests },
  async () => {
    assertIsolatedMongoIntegrationEnvironment();
    const { db } = await connectToDatabase();
    const now = new Date();
    const fixtureId = new ObjectId().toHexString();
    const ownerId = new ObjectId();
    const otherUserId = new ObjectId();
    const websiteId = new ObjectId();
    const linkedScanId = new ObjectId();
    const anonymousScanId = new ObjectId();
    const jobId = `job_test_${fixtureId}`;
    const anonymousToken = createOpaqueAccessToken();

    const ownerWebsite: WebsiteDocument = {
      _id: websiteId,
      userId: ownerId,
      hostname: `fixture-${fixtureId}.example.test`,
      displayName: "Tenant A fixture",
      verifiedStatus: false,
      monitoringEnabled: false,
      monitoringFrequency: "weekly",
      createdAt: now,
      updatedAt: now,
    };
    const linkedScan = { ...fixtureScan(now, websiteId), _id: linkedScanId, crawlProvider: "common-crawl" as const };
    const anonymousScan = {
      ...fixtureScan(now),
      _id: anonymousScanId,
      anonymousAccessTokenHash: hashOpaqueAccessToken(anonymousToken),
    };
    const auditJob: CrawlJobDocument = {
      jobId,
      url: "https://example.test/",
      crawlProvider: "common-crawl",
      clerkUserId: ownerId.toHexString(),
      websiteId,
      status: "queued",
      progressPercent: 0,
      pagesCrawled: 0,
      scanId: new ObjectId(),
      createdAt: now,
    };

    try {
      await db.collection("users").insertMany([
        { _id: ownerId, email: `owner-${fixtureId}@example.test`, role: "user", createdAt: now, updatedAt: now },
        { _id: otherUserId, email: `other-${fixtureId}@example.test`, role: "user", createdAt: now, updatedAt: now },
      ]);
      await db.collection<WebsiteDocument>("websites").insertOne(ownerWebsite);
      await db.collection<ScanDocument>("scans").insertMany([linkedScan, anonymousScan]);
      await db.collection<CrawlJobDocument>("crawlJobs").insertOne(auditJob);

      assert.ok(await getScanByIdForAccess(linkedScanId.toHexString(), { userId: ownerId.toHexString() }));
      assert.equal(await getScanByIdForAccess(linkedScanId.toHexString(), { userId: otherUserId.toHexString() }), null);
      assert.equal(await getScanByIdForAccess(linkedScanId.toHexString()), null);

      assert.equal(await getScanByIdForAccess(anonymousScanId.toHexString()), null);
      assert.equal(await getScanByIdForAccess(anonymousScanId.toHexString(), { userId: ownerId.toHexString() }), null);
      assert.ok(await getScanByIdForAccess(anonymousScanId.toHexString(), { accessToken: anonymousToken }));

      assert.ok(await AuditService.getCrawlJobStatus(jobId, { userId: ownerId.toHexString() }));
      assert.equal(await AuditService.getCrawlJobStatus(jobId, { userId: otherUserId.toHexString() }), null);
      assert.equal(await AuditService.getCrawlJobStatus(jobId), null);

      // Status reads must neither claim work nor switch a queued archive job
      // into crawling; only the external durable worker may perform that state
      // transition after its atomic lease claim.
      const unchangedJob = await db.collection<CrawlJobDocument>("crawlJobs").findOne({ jobId });
      assert.equal(unchangedJob?.status, "queued");
      assert.equal(unchangedJob?.crawlProvider, "common-crawl");
    } finally {
      await Promise.all([
        db.collection("crawlJobs").deleteOne({ jobId }),
        db.collection("scans").deleteMany({ _id: { $in: [linkedScanId, anonymousScanId] } }),
        db.collection("websites").deleteOne({ _id: websiteId }),
        db.collection("users").deleteMany({ _id: { $in: [ownerId, otherUserId] } }),
      ]);
    }
  }
);
