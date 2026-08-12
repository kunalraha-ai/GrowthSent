import { ObjectId } from "bson";
import type { ClientSession, Db, Filter } from "mongodb";
import { randomBytes } from "node:crypto";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { validateUrlForScan } from "../security/ssrf.js";
import { createOpaqueAccessToken, hashOpaqueAccessToken, verifyOpaqueAccessToken } from "../security/access-token.js";
import { createCommonCrawlRequesterKey } from "../security/common-crawl-requester.js";
import {
  getConfiguredCrawlProviderName,
  resolvePersistedCrawlProvider,
  runCrawlWithProvider,
  shouldRetryDurableCrawlAttempt,
} from "../crawler/provider.js";
import {
  acquireCommonCrawlAdmission,
  COMMON_CRAWL_ADMISSION_RETRY_DELAY_MS,
  CommonCrawlAdmissionDeferredError,
  isCommonCrawlAdmissionDeferred,
} from "../crawler/common-crawl-admission.js";
import { commonCrawlMetricsFromError } from "../crawler/providers/common-crawl.js";
import { admitAndInsertCrawlJob, releaseCrawlAdmission } from "../jobs/crawl-admission.js";
import type { CrawlExecutionResult } from "../crawler/crawler.js";
import { analyzeCrawlResults } from "../seo/engine.js";
import {
  CrawlJobDocument,
  ScanDocument,
  PageDocument,
  IssueDocument,
  CrawlSnapshotDocument,
  SeoIssueHistoryDocument,
  ScanStatus,
  WebsiteDocument,
} from "../db/types.js";

const MAX_ATTEMPTS = 3;
const LEASE_DURATION_MS = 15 * 60 * 1000;
const ISSUE_HISTORY_EVENT_LIMIT = 100;

export interface CrawlJobAccessContext {
  userId?: string;
  accessToken?: string;
}

export type CreatedCrawlJob = { jobId: string; status: string; accessToken?: string; reused?: boolean };

interface ClaimedCrawlJob extends CrawlJobDocument {
  _id: ObjectId;
  leaseId: string;
  leaseExpiresAt: Date;
  attempts: number;
}

class LeaseLostError extends Error {
  constructor() {
    super("The crawl lease is no longer held by this worker.");
  }
}

function nextRetryAt(attempts: number): Date {
  const delayMs = Math.min(5 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs);
}

function retryableClaimFilter(now: Date): Filter<CrawlJobDocument> {
  const legacyLeaseCutoff = new Date(now.getTime() - LEASE_DURATION_MS);
  return {
    $and: [
      {
        $or: [{ attempts: { $exists: false } }, { attempts: { $lt: MAX_ATTEMPTS } }],
      },
      {
        $or: [
          {
            $and: [
              { status: "queued" as ScanStatus },
              {
                $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
              },
            ],
          },
          {
            $and: [
              { status: { $in: ["crawling", "analysing"] as ScanStatus[] } },
              {
                $or: [
                  { leaseExpiresAt: { $lte: now } },
                  {
                    $and: [
                      { leaseExpiresAt: { $exists: false } },
                      { createdAt: { $lte: legacyLeaseCutoff } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function normalizeAccess(access: CrawlJobAccessContext | string | undefined): CrawlJobAccessContext {
  return typeof access === "string" ? { userId: access } : access || {};
}

function isTransactionUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /transaction numbers are only allowed|replica set|transactions are not supported/i.test(message);
}

function isSuccessfulCrawlForLifecycle(scan: ScanDocument, pages: PageDocument[]): boolean {
  return pages.some((page) => page.url === scan.url && page.statusCode >= 200 && page.statusCode < 400);
}

function crawlStatsForResult(crawl: CrawlExecutionResult, attempts: number): ScanDocument["crawlStats"] {
  const durableRetries = Math.max(0, attempts - 1);
  const commonCrawl = crawl.commonCrawlMetrics
    ? {
        ...crawl.commonCrawlMetrics,
        retries: crawl.commonCrawlMetrics.retries + durableRetries,
        failures: crawl.commonCrawlMetrics.failures + durableRetries,
      }
    : undefined;
  return {
    totalPagesCrawled: crawl.totalPagesCrawled,
    totalDurationMs: crawl.durationMs,
    bytesDownloaded: crawl.bytesDownloaded,
    statusCodesCount: crawl.statusCodesCount,
    provider: crawl.provider || "live",
    commonCrawl,
  };
}

export class AuditService {
  /**
   * Enqueues a crawl job only. A durable worker must call `processCrawlJob` or
   * `processNextCrawlJob`; HTTP request handlers must never run the crawl.
   */
  static async createCrawlJob(
    inputUrl: string,
    clerkUserId?: string,
    websiteId?: string,
    requestIp?: string
  ): Promise<CreatedCrawlJob> {
    const ssrf = await validateUrlForScan(inputUrl);
    if (!ssrf.isValid || !ssrf.normalizedUrl) {
      throw new Error(ssrf.reason || "Invalid URL for scan.");
    }

    const { db, client } = await connectToDatabase();
    const websiteObjectId = websiteId ? safeObjectId(websiteId) : undefined;

    // Relationship creation is authorized here as well as at the route. This
    // prevents future callers from associating an anonymous job with a private
    // website by supplying its ObjectId.
    if (websiteObjectId) {
      if (!clerkUserId) throw new Error("Authentication is required to audit a saved website.");
      const website = await db.collection("websites").findOne({
        _id: websiteObjectId,
        userId: safeObjectId(clerkUserId),
      });
      if (!website) throw new Error("Website not found.");
    }

    const rawAccessToken = clerkUserId ? undefined : createOpaqueAccessToken();
    const crawlProvider = getConfiguredCrawlProviderName();
    const commonCrawlRequesterKey =
      crawlProvider === "common-crawl"
        ? createCommonCrawlRequesterKey({ userId: clerkUserId, requestIp })
        : undefined;
    const now = new Date();
    const jobId = `job_${randomBytes(24).toString("hex")}`;
    const jobDoc: CrawlJobDocument = {
      jobId,
      url: ssrf.normalizedUrl,
      crawlProvider,
      commonCrawlRequesterKey,
      clerkUserId,
      websiteId: websiteObjectId,
      accessTokenHash: rawAccessToken ? hashOpaqueAccessToken(rawAccessToken) : undefined,
      status: "queued",
      progressPercent: 0,
      pagesCrawled: 0,
      scanId: new ObjectId(),
      attempts: 0,
      createdAt: now,
    };

    const admission = await admitAndInsertCrawlJob(client, db, jobDoc, requestIp);
    if (admission.reusedJobId) {
      return { jobId: admission.reusedJobId, status: admission.reusedStatus || "queued", reused: true };
    }
    return { jobId, status: "queued", accessToken: rawAccessToken };
  }

  /**
   * Returns null for unknown or unauthorized jobs. It never starts work while
   * serving a polling request.
   */
  static async getCrawlJobStatus(
    jobId: string,
    access: CrawlJobAccessContext | string | undefined = {}
  ) {
    const { db } = await connectToDatabase();
    const job = await db.collection<CrawlJobDocument>("crawlJobs").findOne({ jobId });
    if (!job || !(await AuditService.canAccessJob(db, job, normalizeAccess(access)))) return null;

    if (job.status === "completed" && job.scanId) {
      const scan = await db.collection<ScanDocument>("scans").findOne({ _id: job.scanId });
      const pages = await db
        .collection<PageDocument>("pages")
        .find({ scanId: job.scanId })
        .limit(100)
        .toArray();
      const issues = await db.collection<IssueDocument>("issues").find({ scanId: job.scanId }).toArray();

      return {
        jobId: job.jobId,
        status: job.status,
        progressPercent: 100,
        pagesCrawled: job.pagesCrawled,
        scan,
        pages,
        issues,
      };
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progressPercent: job.progressPercent,
      pagesCrawled: job.pagesCrawled,
      // Never return persisted errors: historical rows can contain raw
      // target-controlled URLs or internal driver/provider details.
      error: job.status === "failed" ? "Crawl could not be completed." : undefined,
    };
  }

  private static async canAccessJob(db: Db, job: CrawlJobDocument, access: CrawlJobAccessContext): Promise<boolean> {
    if (job.websiteId) {
      if (!access.userId) return false;
      try {
        const website = await db.collection("websites").findOne({
          _id: job.websiteId,
          userId: safeObjectId(access.userId),
        });
        return Boolean(website);
      } catch {
        return false;
      }
    }

    if (job.clerkUserId) return Boolean(access.userId && job.clerkUserId === access.userId);
    return verifyOpaqueAccessToken(access.accessToken, job.accessTokenHash);
  }

  private static async claimCrawlJob(jobId: string): Promise<ClaimedCrawlJob | null> {
    const { db } = await connectToDatabase();
    const now = new Date();
    const leaseId = new ObjectId().toHexString();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
    const claimed = await db.collection<CrawlJobDocument>("crawlJobs").findOneAndUpdate(
      { jobId, ...retryableClaimFilter(now) },
      {
        $set: {
          status: "crawling",
          progressPercent: 10,
          leaseId,
          leaseExpiresAt,
          startedAt: now,
        },
        $inc: { attempts: 1 },
        $unset: { nextAttemptAt: "" },
      },
      { returnDocument: "after" }
    );

    if (!claimed || !claimed._id || !claimed.leaseId || !claimed.leaseExpiresAt) return null;
    const job = claimed as ClaimedCrawlJob;

    if (job.websiteId) {
      // Issue-history identity is per website. Serialize saved-site audits on
      // the existing website document so lifecycle upserts remain correct even
      // before the optional unique history index is provisioned.
      const websiteLease = await db.collection<WebsiteDocument>("websites").findOneAndUpdate(
        {
          _id: job.websiteId,
          $or: [
            { activeAuditLeaseExpiresAt: { $exists: false } },
            { activeAuditLeaseExpiresAt: { $lte: now } },
            { activeAuditLeaseId: job.leaseId },
          ],
        },
        {
          $set: {
            activeAuditLeaseId: job.leaseId,
            activeAuditLeaseExpiresAt: leaseExpiresAt,
          },
        },
        { returnDocument: "after" }
      );

      if (!websiteLease) {
        const websiteExists = await db.collection<WebsiteDocument>("websites").findOne(
          { _id: job.websiteId },
          { projection: { _id: 1 } }
        );
        if (!websiteExists) {
          await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
            { _id: job._id, leaseId: job.leaseId },
            {
              $set: {
                status: "failed",
                error: "Saved website is no longer available.",
                completedAt: new Date(),
              },
              $unset: { leaseId: "", leaseExpiresAt: "" },
            }
          );
        } else {
          // A second queued job for the same site must not consume an attempt
          // while another worker has the site-level lifecycle lease.
          await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
            { _id: job._id, leaseId: job.leaseId },
            {
              $set: { status: "queued", nextAttemptAt: new Date(Date.now() + 30_000) },
              $inc: { attempts: -1 },
              $unset: { leaseId: "", leaseExpiresAt: "" },
            }
          );
        }
        return null;
      }
    }

    return job;
  }

  private static async ensureLease(db: Db, job: ClaimedCrawlJob, session?: ClientSession): Promise<void> {
    const owned = await db.collection<CrawlJobDocument>("crawlJobs").findOne(
      { _id: job._id, leaseId: job.leaseId, leaseExpiresAt: { $gt: new Date() } },
      { session, projection: { _id: 1 } }
    );
    if (!owned) throw new LeaseLostError();

    if (job.websiteId) {
      const siteLease = await db.collection<WebsiteDocument>("websites").findOne(
        {
          _id: job.websiteId,
          activeAuditLeaseId: job.leaseId,
          activeAuditLeaseExpiresAt: { $gt: new Date() },
        },
        { session, projection: { _id: 1 } }
      );
      if (!siteLease) throw new LeaseLostError();
    }
  }

  private static async releaseWebsiteLease(job: ClaimedCrawlJob): Promise<void> {
    if (!job.websiteId) return;
    const { db } = await connectToDatabase();
    await db.collection<WebsiteDocument>("websites").updateOne(
      { _id: job.websiteId, activeAuditLeaseId: job.leaseId },
      { $unset: { activeAuditLeaseId: "", activeAuditLeaseExpiresAt: "" } }
    );
  }

  /**
   * A write fence, used inside the result transaction just before publication.
   * This prevents a job whose site lease expired during a long crawl from
   * committing lifecycle changes after another job acquired that same site.
   */
  private static async fenceWebsiteLease(db: Db, job: ClaimedCrawlJob, session: ClientSession): Promise<void> {
    if (!job.websiteId) return;
    const updated = await db.collection<WebsiteDocument>("websites").updateOne(
      {
        _id: job.websiteId,
        activeAuditLeaseId: job.leaseId,
        activeAuditLeaseExpiresAt: { $gt: new Date() },
      },
      { $set: { activeAuditLeaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS) } },
      { session }
    );
    if (updated.matchedCount !== 1) throw new LeaseLostError();
  }

  private static async ensureScanId(job: ClaimedCrawlJob): Promise<ObjectId> {
    if (job.scanId) return job.scanId;
    const scanId = new ObjectId();
    const { db } = await connectToDatabase();
    const updated = await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
      { _id: job._id, leaseId: job.leaseId, scanId: { $exists: false } },
      { $set: { scanId } }
    );
    if (updated.matchedCount !== 1) throw new LeaseLostError();
    job.scanId = scanId;
    return scanId;
  }

  private static async markAttemptFailed(job: ClaimedCrawlJob, error?: unknown, jobStartedAt?: number): Promise<void> {
    const { db } = await connectToDatabase();
    // Malformed index/WARC responses are terminal for this job; only provider
    // faults classified transient receive the existing durable retry policy.
    const retry = shouldRetryDurableCrawlAttempt(job.attempts, MAX_ATTEMPTS, error);
    const setFields: Record<string, unknown> = {
      status: retry ? "queued" : "failed",
      error: retry ? "Crawl attempt failed and will be retried." : "Crawl failed after the maximum retry attempts.",
    };
    if (retry) setFields.nextAttemptAt = nextRetryAt(job.attempts);
    else setFields.completedAt = new Date();

    const commonCrawl = commonCrawlMetricsFromError(error);
    if (commonCrawl) {
      const durableRetries = Math.max(0, job.attempts - 1);
      setFields.instrumentation = {
        provider: "common-crawl",
        commonCrawl: {
          ...commonCrawl,
          retries: commonCrawl.retries + durableRetries,
          failures: commonCrawl.failures + durableRetries,
        },
        totalJobDurationMs: jobStartedAt === undefined ? undefined : Math.max(0, Date.now() - jobStartedAt),
      };
    }

    const updated = await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
      { _id: job._id, leaseId: job.leaseId },
      {
        $set: setFields,
        $unset: { leaseId: "", leaseExpiresAt: "", ...(retry ? { completedAt: "" } : {}) },
      }
    );
    if (!retry && updated.matchedCount === 1) {
      await releaseCrawlAdmission(db, job);
    }
  }

  /** Requeue admission contention without consuming a durable crawl attempt. */
  private static async deferForCommonCrawlAdmission(job: ClaimedCrawlJob): Promise<void> {
    const { db } = await connectToDatabase();
    await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
      { _id: job._id, leaseId: job.leaseId },
      {
        $set: {
          status: "queued",
          nextAttemptAt: new Date(Date.now() + COMMON_CRAWL_ADMISSION_RETRY_DELAY_MS),
        },
        $inc: { attempts: -1 },
        $unset: { leaseId: "", leaseExpiresAt: "", error: "" },
      }
    );
  }

  private static async syncIssueLifecycle(
    db: Db,
    websiteId: ObjectId,
    issues: IssueDocument[],
    scanId: ObjectId,
    timestamp: Date,
    resolveMissing: boolean,
    session?: ClientSession
  ): Promise<void> {
    const history = db.collection<SeoIssueHistoryDocument>("seoIssueHistory");
    const issueKey = (ruleId: string, affectedUrl: string) => `${ruleId}\u0000${affectedUrl}`;
    const currentIssues = new Map<string, IssueDocument>();
    for (const issue of issues) currentIssues.set(issueKey(issue.ruleId, issue.affectedUrl), issue);

    const activeHistory = await history.find({ websiteId, status: "active" }, { session }).toArray();
    const activeByKey = new Map(activeHistory.map((item) => [issueKey(item.ruleId, item.affectedUrl), item]));

    for (const [key, issue] of currentIssues) {
      const active = activeByKey.get(key);
      if (active) {
        // A continuing issue updates its observation timestamp but does not add
        // another event. This bounds write amplification and history growth.
        await history.updateOne(
          { _id: active._id, status: "active" },
          {
            $set: {
              category: issue.category,
              severity: issue.severity,
              title: issue.title,
              lastDetectedAt: timestamp,
              updatedAt: timestamp,
            },
          },
          { session }
        );
        continue;
      }

      const existing = await history.findOne(
        { websiteId, ruleId: issue.ruleId, affectedUrl: issue.affectedUrl },
        { session }
      );
      if (existing?.status === "resolved") {
        await history.updateOne(
          { _id: existing._id, status: "resolved" },
          {
            $set: {
              category: issue.category,
              severity: issue.severity,
              title: issue.title,
              status: "active",
              lastDetectedAt: timestamp,
              reoccurredAt: timestamp,
              updatedAt: timestamp,
            },
            $unset: { resolvedAt: "" },
            $push: {
              historyEvents: {
                $each: [{ event: "reoccurred", timestamp, scanId }],
                $slice: -ISSUE_HISTORY_EVENT_LIMIT,
              },
            },
          },
          { session }
        );
        continue;
      }

      await history.updateOne(
        { websiteId, ruleId: issue.ruleId, affectedUrl: issue.affectedUrl },
        {
          $set: {
            category: issue.category,
            severity: issue.severity,
            title: issue.title,
            status: "active",
            lastDetectedAt: timestamp,
            updatedAt: timestamp,
          },
          $setOnInsert: {
            firstDetectedAt: timestamp,
            createdAt: timestamp,
            historyEvents: [{ event: "detected", timestamp, scanId }],
          },
        },
        { upsert: true, session }
      );
    }

    if (!resolveMissing) return;
    for (const previous of activeHistory) {
      if (currentIssues.has(issueKey(previous.ruleId, previous.affectedUrl))) continue;
      await history.updateOne(
        { _id: previous._id, status: "active" },
        {
          $set: { status: "resolved", resolvedAt: timestamp, updatedAt: timestamp },
          $push: {
            historyEvents: {
              $each: [{ event: "resolved", timestamp, scanId }],
              $slice: -ISSUE_HISTORY_EVENT_LIMIT,
            },
          },
        },
        { session }
      );
    }
  }

  private static async persistResults(
    job: ClaimedCrawlJob,
    scanDoc: ScanDocument,
    pages: PageDocument[],
    issues: IssueDocument[],
    snapshot: CrawlSnapshotDocument | undefined,
    completionTime: Date,
    jobStartedAt: number
  ): Promise<void> {
    const { client, db } = await connectToDatabase();
    const session = client.startSession();
    const scanId = scanDoc._id!;
    const persistenceStartedAt = Date.now();

    try {
      await session.withTransaction(async () => {
        await AuditService.ensureLease(db, job, session);
        await db.collection<ScanDocument>("scans").replaceOne({ _id: scanId }, scanDoc, { upsert: true, session });
        await db.collection<PageDocument>("pages").deleteMany({ scanId }, { session });
        await db.collection<IssueDocument>("issues").deleteMany({ scanId }, { session });
        if (pages.length > 0) await db.collection<PageDocument>("pages").insertMany(pages, { session });
        if (issues.length > 0) await db.collection<IssueDocument>("issues").insertMany(issues, { session });
        if (snapshot) {
          await db.collection<CrawlSnapshotDocument>("crawlSnapshots").replaceOne(
            { scanId },
            snapshot,
            { upsert: true, session }
          );
        }
        if (job.websiteId) {
          await AuditService.syncIssueLifecycle(
            db,
            job.websiteId,
            issues,
            scanId,
            completionTime,
            isSuccessfulCrawlForLifecycle(scanDoc, pages),
            session
          );
        }

        const completedScan = await db.collection<ScanDocument>("scans").updateOne(
          { _id: scanId },
          {
            $set: {
              status: "completed",
              completionTime,
              "crawlStats.mongoPersistenceMs": Math.max(0, Date.now() - persistenceStartedAt),
              "crawlStats.totalJobDurationMs": Math.max(0, Date.now() - jobStartedAt),
            },
          },
          { session }
        );
        if (completedScan.matchedCount !== 1) throw new LeaseLostError();

        await AuditService.fenceWebsiteLease(db, job, session);

        const completedJob = await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
          { _id: job._id, leaseId: job.leaseId, leaseExpiresAt: { $gt: new Date() } },
          {
            $set: {
              status: "completed",
              progressPercent: 100,
              pagesCrawled: pages.length,
              completedAt: completionTime,
              instrumentation: {
                provider: scanDoc.crawlStats.provider || "live",
                commonCrawl: scanDoc.crawlStats.commonCrawl,
                mongoPersistenceMs: Math.max(0, Date.now() - persistenceStartedAt),
                totalJobDurationMs: Math.max(0, Date.now() - jobStartedAt),
              },
            },
            $unset: { leaseId: "", leaseExpiresAt: "", nextAttemptAt: "", error: "" },
          },
          { session }
        );
        if (completedJob.matchedCount !== 1) throw new LeaseLostError();
        await releaseCrawlAdmission(db, job, session);
      });
    } catch (error) {
      // A standalone MongoDB server cannot atomically fence child writes from
      // a worker whose lease may have expired. Do not publish partial/stale
      // crawl data; the job will retry and ultimately fail safely instead.
      if (isTransactionUnsupported(error)) {
        throw new Error("Atomic audit result persistence requires a MongoDB replica set.");
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private static startLeaseHeartbeat(job: ClaimedCrawlJob): () => void {
    const interval = setInterval(() => {
      void connectToDatabase()
        .then(async ({ db }) => {
          const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);
          await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
            { _id: job._id, leaseId: job.leaseId, status: { $in: ["crawling", "analysing"] } },
            { $set: { leaseExpiresAt } }
          );
          if (job.websiteId) {
            await db.collection<WebsiteDocument>("websites").updateOne(
              { _id: job.websiteId, activeAuditLeaseId: job.leaseId },
              { $set: { activeAuditLeaseExpiresAt: leaseExpiresAt } }
            );
          }
        })
        .catch(() => console.error("[AuditService] Unable to renew crawl lease."));
    }, Math.floor(LEASE_DURATION_MS / 3));
    interval.unref?.();
    return () => clearInterval(interval);
  }

  /** Processes one named job for an external durable worker. */
  static async processCrawlJob(jobId: string): Promise<{ claimed: boolean; status?: ScanStatus; attempt?: number; queueAgeMs?: number }> {
    const job = await AuditService.claimCrawlJob(jobId);
    if (!job) return { claimed: false };
    const queueAgeMs = Math.max(0, Date.now() - job.createdAt.getTime());
    const stopHeartbeat = AuditService.startLeaseHeartbeat(job);
    const jobStartedAt = Date.now();

    try {
      const { db } = await connectToDatabase();
      const scanId = await AuditService.ensureScanId(job);
      // A persisted job is untrusted input to a durable worker. Validate it
      // again before the selected provider forms any external lookup.
      const ssrf = await validateUrlForScan(job.url);
      if (!ssrf.isValid || !ssrf.normalizedUrl) throw new Error("Stored crawl target failed validation.");
      const crawlProvider = resolvePersistedCrawlProvider(job.crawlProvider);
      let crawlResult: CrawlExecutionResult;
      if (crawlProvider === "common-crawl") {
        const admission = await acquireCommonCrawlAdmission({
          jobId: job.jobId,
          requesterKey: job.commonCrawlRequesterKey,
        });
        if (!admission) throw new CommonCrawlAdmissionDeferredError();
        try {
          crawlResult = await runCrawlWithProvider(crawlProvider, ssrf.normalizedUrl, {
            maxPages: 25,
            concurrency: 5,
            timeoutMs: 5000,
          });
        } finally {
          await admission.release().catch(() => {
            console.error("[AuditService] Unable to release Common Crawl admission.");
          });
        }
      } else {
        crawlResult = await runCrawlWithProvider(crawlProvider, ssrf.normalizedUrl, {
          maxPages: 25,
          concurrency: 5,
          timeoutMs: 5000,
        });
      }

      const analysing = await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
        { _id: job._id, leaseId: job.leaseId, leaseExpiresAt: { $gt: new Date() } },
        { $set: { status: "analysing", progressPercent: 70, pagesCrawled: crawlResult.pages.length } }
      );
      if (analysing.matchedCount !== 1) throw new LeaseLostError();

      const completionTime = new Date();
      const analysisRes = analyzeCrawlResults(crawlResult);
      const generatedIssues = analysisRes.issues;
      const scoreResult = analysisRes.scoring;
      const issueCount = (severity: IssueDocument["severity"]) =>
        generatedIssues.filter((issue) => issue.severity === severity).length;

      const scanDoc: ScanDocument = {
        _id: scanId,
        websiteId: job.websiteId,
        clerkUserId: job.clerkUserId,
        crawlProvider,
        url: job.url,
        hostname: crawlResult.hostname,
        startTime: job.createdAt,
        status: "analysing",
        crawlStats: crawlStatsForResult(crawlResult, job.attempts),
        summaryMetrics: {
          totalChecks: scoreResult.totalChecks,
          passedChecks: scoreResult.passedChecks,
          failedChecks: scoreResult.failedChecks,
          criticalIssues: issueCount("critical"),
          highIssues: issueCount("high"),
          mediumIssues: issueCount("medium"),
          lowIssues: issueCount("low"),
          infoIssues: issueCount("info"),
        },
        seoScore: scoreResult.score,
        ruleVersion: scoreResult.scoreVersion,
        scoreVersion: scoreResult.scoreVersion,
        createdAt: completionTime,
      };

      const pages: PageDocument[] = crawlResult.pages.map((page) => ({
        scanId,
        websiteId: job.websiteId,
        url: page.url,
        normalizedUrl: page.normalizedUrl,
        statusCode: page.statusCode,
        responseTimeMs: page.responseTimeMs,
        contentType: page.contentType,
        pageSizeBytes: page.pageSizeBytes,
        title: page.parsedData?.title,
        metaDescription: page.parsedData?.metaDescription,
        headings: page.parsedData?.headings || { h1: [], h2Count: 0, h3Count: 0 },
        canonicalUrl: page.parsedData?.canonicalUrl,
        isNoindex: page.parsedData?.isNoindex || false,
        isNofollow: page.parsedData?.isNofollow || false,
        hasRobotsTxtDisallow: page.hasRobotsTxtDisallow,
        structuredDataTypes: page.parsedData?.structuredDataTypes || [],
        internalLinks: page.parsedData?.internalLinks || [],
        externalLinks: page.parsedData?.externalLinks || [],
        hreflangs: page.parsedData?.hreflangs || {},
        provenance: page.provenance,
        createdAt: completionTime,
      }));
      const issues: IssueDocument[] = generatedIssues.map((issue) => ({
        ...issue,
        scanId,
        websiteId: job.websiteId,
        createdAt: completionTime,
      }));
      const snapshot: CrawlSnapshotDocument | undefined = job.websiteId
        ? {
            websiteId: job.websiteId,
            scanId,
            clerkUserId: job.clerkUserId,
            seoScore: scoreResult.score,
            ruleVersion: scoreResult.scoreVersion,
            totalIssuesCount: generatedIssues.length,
            criticalCount: scanDoc.summaryMetrics.criticalIssues,
            highCount: scanDoc.summaryMetrics.highIssues,
            mediumCount: scanDoc.summaryMetrics.mediumIssues,
            lowCount: scanDoc.summaryMetrics.lowIssues,
            totalPagesCount: crawlResult.pages.length,
            snapshotDate: completionTime,
            createdAt: completionTime,
          }
        : undefined;

      await AuditService.persistResults(job, scanDoc, pages, issues, snapshot, completionTime, jobStartedAt);
      return { claimed: true, status: "completed", attempt: job.attempts, queueAgeMs };
    } catch (error) {
      if (isCommonCrawlAdmissionDeferred(error)) {
        await AuditService.deferForCommonCrawlAdmission(job);
        return { claimed: true, status: "queued", attempt: job.attempts, queueAgeMs };
      }
      if (!(error instanceof LeaseLostError)) {
        console.error("[AuditService] A crawl attempt failed.");
        await AuditService.markAttemptFailed(job, error, jobStartedAt);
      }
      return { claimed: true, status: "failed", attempt: job.attempts, queueAgeMs };
    } finally {
      stopHeartbeat();
      await AuditService.releaseWebsiteLease(job).catch(() => {
        console.error("[AuditService] Unable to release saved-site audit lease.");
      });
    }
  }

  /** Claims and processes one due job for an external durable worker. */
  static async processNextCrawlJob(): Promise<{ claimed: boolean; status?: ScanStatus; attempt?: number; queueAgeMs?: number }> {
    const { db } = await connectToDatabase();
    const candidate = await db
      .collection<CrawlJobDocument>("crawlJobs")
      .find(retryableClaimFilter(new Date()))
      .sort({ createdAt: 1 })
      .project({ jobId: 1 })
      .limit(1)
      .next();
    if (!candidate?.jobId) return { claimed: false };
    return AuditService.processCrawlJob(candidate.jobId);
  }
}
