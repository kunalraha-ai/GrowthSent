import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { ObjectId } from "mongodb";
import { admitAndInsertCrawlJob, CrawlAdmissionError, EXTERNAL_MVP_CRAWL_ADMISSION } from "../lib/jobs/crawl-admission.js";
import { connectToDatabase } from "../lib/db/mongodb.js";
import type { CrawlJobDocument } from "../lib/db/types.js";
import { AuditService } from "../lib/services/audit.service.js";

const enabled = process.env.RUN_MONGODB_INTEGRATION_TESTS === "1";

function assertIsolatedMongoIntegrationEnvironment(env = process.env): void {
  if (env.RUN_MONGODB_INTEGRATION_TESTS !== "1" || env.NODE_ENV !== "test") {
    throw new Error("MongoDB integration tests require explicit test configuration.");
  }
  if (!/(^|[_-])test$/i.test(env.MONGODB_DB_NAME?.trim() || "") || !env.MONGODB_URI?.trim()) {
    throw new Error("MongoDB integration tests require an explicit test database.");
  }
}

function job(nonce: string, suffix: string, userId?: string): CrawlJobDocument {
  return {
    jobId: `job_admission_${nonce}_${suffix}`,
    url: `https://${suffix}-${nonce}.test/`,
    clerkUserId: userId,
    status: "queued",
    progressPercent: 0,
    pagesCrawled: 0,
    attempts: 0,
    scanId: new ObjectId(),
    createdAt: new Date(),
  };
}

test("Mongo admission atomically dedupes concurrent audits, retries transactions, cools down targets, quotas actors, and caps the queue without NoSuchTransaction", { skip: !enabled }, async () => {
  assertIsolatedMongoIntegrationEnvironment();
  const { client, db } = await connectToDatabase();
  const nonce = randomBytes(8).toString("hex");
  const userA = `user-a-${nonce}`;
  const userB = `user-b-${nonce}`;
  const prefix = `job_admission_${nonce}_`;
  const originalQueue = await db.collection("crawlAdmission").findOne({ _id: "queue:external-mvp" });

  try {
    const first = job(nonce, "duplicate", userA);
    const duplicate = job(nonce, "duplicate", userA);
    const [left, right] = await Promise.all([
      admitAndInsertCrawlJob(client, db, first),
      admitAndInsertCrawlJob(client, db, duplicate),
    ]);
    assert.equal([left.reusedJobId, right.reusedJobId].filter(Boolean).length, 1);

    await assert.rejects(
      admitAndInsertCrawlJob(client, db, job(nonce, "duplicate", userB)),
      (error: unknown) => error instanceof CrawlAdmissionError && error.code === "CRAWL_TARGET_COOLDOWN"
    );

    for (let index = 0; index < EXTERNAL_MVP_CRAWL_ADMISSION.authenticatedPerHour - 1; index++) {
      await admitAndInsertCrawlJob(client, db, job(nonce, `quota-${index}`, userA));
    }
    await assert.rejects(
      admitAndInsertCrawlJob(client, db, job(nonce, "quota-overflow", userA)),
      (error: unknown) => error instanceof CrawlAdmissionError && error.code === "CRAWL_QUOTA_EXCEEDED"
    );

    await admitAndInsertCrawlJob(client, db, job(nonce, "anonymous-one"), "203.0.113.22");
    await admitAndInsertCrawlJob(client, db, job(nonce, "anonymous-two"), "203.0.113.22");
    await assert.rejects(
      admitAndInsertCrawlJob(client, db, job(nonce, "anonymous-overflow"), "203.0.113.22"),
      (error: unknown) => error instanceof CrawlAdmissionError && error.code === "CRAWL_QUOTA_EXCEEDED"
    );

    await db.collection("crawlAdmission").updateOne(
      { _id: "queue:external-mvp" },
      { $set: { kind: "queue", activeCount: EXTERNAL_MVP_CRAWL_ADMISSION.queueCap, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );
    await assert.rejects(
      admitAndInsertCrawlJob(client, db, job(nonce, "queue-overflow", userB)),
      (error: unknown) => error instanceof CrawlAdmissionError && error.code === "CRAWL_QUEUE_FULL"
    );
  } finally {
    await db.collection("crawlJobs").deleteMany({ jobId: { $regex: `^${prefix}` } });
    await db.collection("crawlAdmission").deleteMany({ _id: { $regex: nonce } });
    if (originalQueue) {
      await db.collection("crawlAdmission").replaceOne({ _id: "queue:external-mvp" }, originalQueue, { upsert: true });
    } else {
      await db.collection("crawlAdmission").deleteOne({ _id: "queue:external-mvp" });
    }
  }
});

test("overlapping durable workers atomically claim at most one audit lease", { skip: !enabled }, async () => {
  assertIsolatedMongoIntegrationEnvironment();
  const { db } = await connectToDatabase();
  const nonce = randomBytes(8).toString("hex");
  const fixture = job(nonce, "lease", `user-${nonce}`);
  const claim = (AuditService as unknown as {
    claimCrawlJob: (jobId: string) => Promise<unknown>;
  }).claimCrawlJob.bind(AuditService);

  try {
    await db.collection<CrawlJobDocument>("crawlJobs").insertOne(fixture);
    const results = await Promise.all([claim(fixture.jobId), claim(fixture.jobId)]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    await db.collection("crawlJobs").deleteOne({ jobId: fixture.jobId });
  }
});
