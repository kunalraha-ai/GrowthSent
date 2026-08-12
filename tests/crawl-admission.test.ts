import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "bson";
import type { ClientSession, Db, MongoClient } from "mongodb";
import {
  admitAndInsertCrawlJob,
  EXTERNAL_MVP_CRAWL_ADMISSION,
  createAnonymousAdmissionActorKey,
  createCrawlAdmissionTargetKey,
  isActiveCrawlStatus,
} from "../lib/jobs/crawl-admission.js";
import type { CrawlJobDocument } from "../lib/db/types.js";

test("persistent audit-admission identifiers are privacy-preserving and domain-scoped", () => {
  const key = createAnonymousAdmissionActorKey("203.0.113.42");
  assert.match(key, /^anonymous:[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /203\.0\.113\.42/);
  assert.equal(createCrawlAdmissionTargetKey("https://www.example.co.uk/path"), "example.co.uk");
});

test("external-MVP admission policy has intentionally low bounded limits", () => {
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.authenticatedPerHour, 8);
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.anonymousPerHour, 2);
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.queueCap, 25);
  assert.equal(isActiveCrawlStatus("queued"), true);
  assert.equal(isActiveCrawlStatus("completed"), false);
});

test("admission retries an aborted duplicate-claim transaction with a fresh session and sequential operations", async () => {
  const documents = new Map<string, Map<string, Record<string, unknown>>>();
  const operations: string[] = [];
  let activeSession: ClientSession | undefined;
  let inFlight = false;
  let sessionsStarted = 0;
  let failFirstActiveInsert = true;

  const recordsFor = (collection: string) => {
    let records = documents.get(collection);
    if (!records) {
      records = new Map();
      documents.set(collection, records);
    }
    return records;
  };
  const observe = async <T>(name: string, options: unknown, action: () => T): Promise<T> => {
    assert.equal((options as { session?: ClientSession }).session, activeSession, `${name} must use the active transaction session`);
    assert.equal(inFlight, false, `${name} must not overlap another MongoDB operation on the session`);
    inFlight = true;
    await Promise.resolve();
    operations.push(`session-${sessionsStarted}:${name}`);
    try {
      return action();
    } finally {
      inFlight = false;
    }
  };

  const fakeDb = {
    collection(collectionName: string) {
      const records = recordsFor(collectionName);
      return {
        findOne: async (filter: { _id?: string; jobId?: string }, options: unknown) => observe(
          `${collectionName}.findOne`,
          options,
          () => {
            if (filter._id) return records.get(filter._id) || null;
            if (filter.jobId) return [...records.values()].find((record) => record.jobId === filter.jobId) || null;
            return null;
          }
        ),
        insertOne: async (document: Record<string, unknown>, options: unknown) => observe(
          `${collectionName}.insertOne`,
          options,
          () => {
            if (collectionName === "crawlAdmission" && document.kind === "active" && failFirstActiveInsert) {
              failFirstActiveInsert = false;
              const duplicate = Object.assign(new Error("duplicate key"), { code: 11000 });
              throw duplicate;
            }
            const id = String(document._id);
            if (records.has(id)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
            records.set(id, document);
            return { acknowledged: true, insertedId: id };
          }
        ),
        updateOne: async (_filter: unknown, _update: unknown, options: unknown) => observe(
          `${collectionName}.updateOne`,
          options,
          () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 })
        ),
      };
    },
  } as unknown as Db;

  const fakeClient = {
    async withSession<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
      sessionsStarted += 1;
      const session = {
        async withTransaction<U>(transaction: () => Promise<U>): Promise<U> {
          return transaction();
        },
      } as unknown as ClientSession;
      activeSession = session;
      try {
        return await callback(session);
      } finally {
        activeSession = undefined;
      }
    },
  } as unknown as MongoClient;

  const job = (jobId: string): CrawlJobDocument => ({
    jobId,
    url: "https://retry.example.test/",
    clerkUserId: "test-user",
    status: "queued",
    progressPercent: 0,
    pagesCrawled: 0,
    scanId: new ObjectId(),
    attempts: 0,
    createdAt: new Date(),
  });

  const first = await admitAndInsertCrawlJob(fakeClient, fakeDb, job("job_retry_first"));
  assert.equal(first.queueSlotClaimed, true);
  assert.equal(sessionsStarted, 2, "duplicate claim must restart the complete transaction with a new session");
  assert.deepEqual(operations.slice(0, 2), [
    "session-1:crawlAdmission.findOne",
    "session-1:crawlAdmission.insertOne",
  ]);
  assert.equal(operations.some((operation) => operation.startsWith("session-1:") && operation.endsWith("crawlJobs.findOne")), false);
  assert.deepEqual(operations.slice(2), [
    "session-2:crawlAdmission.findOne",
    "session-2:crawlAdmission.insertOne",
    "session-2:crawlAdmission.findOne",
    "session-2:crawlAdmission.insertOne",
    "session-2:crawlAdmission.findOne",
    "session-2:crawlAdmission.insertOne",
    "session-2:crawlAdmission.findOne",
    "session-2:crawlAdmission.insertOne",
    "session-2:crawlJobs.insertOne",
  ]);

  const duplicateStart = operations.length;
  const duplicate = await admitAndInsertCrawlJob(fakeClient, fakeDb, job("job_retry_duplicate"));
  assert.equal(duplicate.reusedJobId, "job_retry_first");
  assert.equal(duplicate.queueSlotClaimed, false);
  assert.deepEqual(operations.slice(duplicateStart), [
    "session-3:crawlAdmission.findOne",
    "session-3:crawlJobs.findOne",
  ]);
});
