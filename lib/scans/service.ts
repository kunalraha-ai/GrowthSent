import { ObjectId } from "bson";
import type { ClientSession, Db, Filter } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { PageDocument, IssueDocument, ScanDocument, ScanStatus } from "../db/types.js";
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
import type { CrawlExecutionResult } from "../crawler/crawler.js";
import { analyzeCrawlResults } from "../seo/engine.js";
import { buildPublicAuditReport, type PublicAuditReport } from "../audits/public-report.js";

const MAX_SCAN_PAGES = 200;
const MAX_ATTEMPTS = 3;
const LEASE_DURATION_MS = 15 * 60 * 1000;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface CreateScanOptions {
  url: string;
  websiteId?: string;
  /** Required whenever `websiteId` is supplied and used for standalone authenticated scans. */
  userId?: string;
  anonymousSessionId?: string;
  /** Trusted ingress IP, used only to derive an opaque archive admission key. */
  requestIp?: string;
  maxPages?: number;
}

export interface ScanAccessContext {
  userId?: string;
  accessToken?: string;
}

export type CreatedScan = ScanDocument & { accessToken?: string };

interface ClaimedScan extends ScanDocument {
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

function boundedMaxPages(maxPages: number | undefined): number {
  if (!Number.isFinite(maxPages)) return 50;
  return Math.max(1, Math.min(Math.floor(maxPages as number), MAX_SCAN_PAGES));
}

function nextRetryAt(attempts: number): Date {
  // Cap the delay at five minutes so a transient failure is retried, without a tight loop.
  const delayMs = Math.min(5 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs);
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

function retryableClaimFilter(now: Date): Filter<ScanDocument> {
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
                  // Jobs created before leases existed are recovered only after
                  // a full lease interval, never while they may still be live.
                  {
                    $and: [
                      { leaseExpiresAt: { $exists: false } },
                      { startTime: { $lte: legacyLeaseCutoff } },
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

/**
 * Enqueues a scan only. A durable worker must call `runScanJob` or
 * `processNextQueuedScan`; HTTP request handlers must not execute crawls.
 */
export async function createScan(options: CreateScanOptions): Promise<CreatedScan> {
  const ssrf = await validateUrlForScan(options.url);
  if (!ssrf.isValid || !ssrf.normalizedUrl || !ssrf.hostname) {
    throw new Error(ssrf.reason || "Invalid URL for scanning.");
  }

  const { db } = await connectToDatabase();
  const ownerUserId = options.userId ? safeObjectId(options.userId) : undefined;
  const websiteId = options.websiteId ? safeObjectId(options.websiteId) : undefined;

  // A private website relationship must never be created by an anonymous caller
  // or a caller who does not own the target website.
  if (websiteId) {
    if (!ownerUserId) {
      throw new Error("Authentication is required to scan a saved website.");
    }
    const website = await db.collection("websites").findOne({ _id: websiteId, userId: ownerUserId });
    if (!website) {
      throw new Error("Website not found.");
    }
  }

  const rawAccessToken = ownerUserId ? undefined : createOpaqueAccessToken();
  const crawlProvider = getConfiguredCrawlProviderName();
  const commonCrawlRequesterKey =
    crawlProvider === "common-crawl"
      ? createCommonCrawlRequesterKey({ userId: ownerUserId?.toHexString(), requestIp: options.requestIp })
      : undefined;
  const now = new Date();
  const scanDoc: ScanDocument = {
    url: ssrf.normalizedUrl,
    hostname: ssrf.hostname,
    websiteId,
    ownerUserId,
    anonymousSessionId: options.anonymousSessionId,
    anonymousAccessTokenHash: rawAccessToken ? hashOpaqueAccessToken(rawAccessToken) : undefined,
    requestedMaxPages: boundedMaxPages(options.maxPages),
    crawlProvider,
    commonCrawlRequesterKey,
    attempts: 0,
    startTime: now,
    status: "queued",
    crawlStats: {
      totalPagesCrawled: 0,
      totalDurationMs: 0,
      bytesDownloaded: 0,
      statusCodesCount: {},
    },
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

  const res = await db.collection<ScanDocument>("scans").insertOne(scanDoc);
  return { ...scanDoc, _id: res.insertedId, accessToken: rawAccessToken };
}

/**
 * Atomically claims a scan for one worker. An expired lease can be recovered by
 * another worker; a live lease cannot be claimed twice.
 */
async function claimScan(scanId: ObjectId): Promise<ClaimedScan | null> {
  const { db } = await connectToDatabase();
  const now = new Date();
  const leaseId = new ObjectId().toHexString();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

  const claimed = await db.collection<ScanDocument>("scans").findOneAndUpdate(
    { _id: scanId, ...retryableClaimFilter(now) },
    {
      $set: {
        status: "crawling",
        startTime: now,
        leaseId,
        leaseExpiresAt,
      },
      $inc: { attempts: 1 },
      $unset: { nextAttemptAt: "" },
    },
    { returnDocument: "after" }
  );

  if (!claimed || !claimed._id || !claimed.leaseId || !claimed.leaseExpiresAt) return null;
  return claimed as ClaimedScan;
}

async function ensureLease(db: Db, scan: ClaimedScan, session?: ClientSession): Promise<void> {
  const owned = await db.collection<ScanDocument>("scans").findOne(
    { _id: scan._id, leaseId: scan.leaseId, leaseExpiresAt: { $gt: new Date() } },
    { session, projection: { _id: 1 } }
  );
  if (!owned) throw new LeaseLostError();
}

async function markScanAttemptFailed(scan: ClaimedScan, error?: unknown, jobStartedAt?: number): Promise<void> {
  const { db } = await connectToDatabase();
  // Archive corruption and validation faults are deterministic; retry only
  // explicitly transient Common Crawl failures, while retaining legacy retry
  // behavior for the live provider and MongoDB failures.
  const retry = shouldRetryDurableCrawlAttempt(scan.attempts, MAX_ATTEMPTS, error);
  const setFields: Record<string, unknown> = {
    status: retry ? "queued" : "failed",
    error: retry ? "Crawl attempt failed and will be retried." : "Crawl failed after the maximum retry attempts.",
  };
  if (retry) setFields.nextAttemptAt = nextRetryAt(scan.attempts);
  else setFields.completionTime = new Date();

  const commonCrawl = commonCrawlMetricsFromError(error);
  if (commonCrawl) {
    const durableRetries = Math.max(0, scan.attempts - 1);
    setFields.crawlStats = {
      ...scan.crawlStats,
      provider: "common-crawl",
      commonCrawl: {
        ...commonCrawl,
        retries: commonCrawl.retries + durableRetries,
        failures: commonCrawl.failures + durableRetries,
      },
      totalJobDurationMs: jobStartedAt === undefined ? undefined : Math.max(0, Date.now() - jobStartedAt),
    };
  }

  await db.collection<ScanDocument>("scans").updateOne(
    { _id: scan._id, leaseId: scan.leaseId },
    {
      $set: setFields,
      $unset: {
        leaseId: "",
        leaseExpiresAt: "",
        ...(retry ? { completionTime: "" } : {}),
      },
    }
  );
}

/**
 * Admission contention is not a crawl failure. Put the claimed document back
 * on the durable queue without consuming an attempt, so a busy global slot or
 * another active request from the same tenant/IP cannot exhaust retries.
 */
async function deferScanForCommonCrawlAdmission(scan: ClaimedScan): Promise<void> {
  const { db } = await connectToDatabase();
  await db.collection<ScanDocument>("scans").updateOne(
    { _id: scan._id, leaseId: scan.leaseId },
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

function isTransactionUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /transaction numbers are only allowed|replica set|transactions are not supported/i.test(message);
}

async function persistCompletedScan(
  scan: ClaimedScan,
  pageDocs: PageDocument[],
  issueDocs: IssueDocument[],
  completionTime: Date,
  crawlStats: ScanDocument["crawlStats"],
  summaryMetrics: ScanDocument["summaryMetrics"],
  seoScore: number,
  scoreVersion: string,
  jobStartedAt: number
): Promise<void> {
  const { client, db } = await connectToDatabase();
  const session = client.startSession();
  const persistenceStartedAt = Date.now();

  try {
    await session.withTransaction(async () => {
      await ensureLease(db, scan, session);

      // A retry always rewrites the same scan's children inside one transaction,
      // so a partial previous attempt cannot become a completed result.
      await db.collection<PageDocument>("pages").deleteMany({ scanId: scan._id }, { session });
      await db.collection<IssueDocument>("issues").deleteMany({ scanId: scan._id }, { session });
      if (pageDocs.length > 0) await db.collection<PageDocument>("pages").insertMany(pageDocs, { session });
      if (issueDocs.length > 0) await db.collection<IssueDocument>("issues").insertMany(issueDocs, { session });

      const updated = await db.collection<ScanDocument>("scans").updateOne(
        { _id: scan._id, leaseId: scan.leaseId, leaseExpiresAt: { $gt: new Date() } },
        {
          $set: {
            status: "completed",
            completionTime,
            crawlStats: {
              ...crawlStats,
              mongoPersistenceMs: Math.max(0, Date.now() - persistenceStartedAt),
              totalJobDurationMs: Math.max(0, Date.now() - jobStartedAt),
            },
            summaryMetrics,
            seoScore,
            scoreVersion,
          },
          $unset: { leaseId: "", leaseExpiresAt: "", nextAttemptAt: "", error: "" },
        },
        { session }
      );
      if (updated.matchedCount !== 1) throw new LeaseLostError();

      if (scan.websiteId) {
        await db.collection("websites").updateOne(
          { _id: scan.websiteId },
          { $set: { lastScanAt: completionTime } },
          { session }
        );
      }
    });
  } catch (error) {
    // Publishing pages, issues, and the completed state cannot be fenced
    // safely on a standalone server after a lease expires. Fail closed rather
    // than letting an old worker overwrite a newer worker's result.
    if (isTransactionUnsupported(error)) {
      throw new Error("Atomic scan result persistence requires a MongoDB replica set.");
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

function startScanLeaseHeartbeat(scan: ClaimedScan): () => void {
  const interval = setInterval(() => {
    void connectToDatabase()
      .then(({ db }) =>
        db.collection<ScanDocument>("scans").updateOne(
          { _id: scan._id, leaseId: scan.leaseId, status: { $in: ["crawling", "analysing"] } },
          { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS) } }
        )
      )
      .catch(() => console.error("[ScanJob] Unable to renew crawl lease."));
  }, Math.floor(LEASE_DURATION_MS / 3));
  interval.unref?.();
  return () => clearInterval(interval);
}

/**
 * Worker-facing scan processor. It returns without work when another worker
 * owns the live lease. It intentionally does not spawn background work.
 */
export async function runScanJob(scanId: string, _maxPages?: number): Promise<{ claimed: boolean; status?: ScanDocument["status"] }> {
  let scanObjId: ObjectId;
  try {
    scanObjId = safeObjectId(scanId);
  } catch {
    return { claimed: false };
  }

  const scan = await claimScan(scanObjId);
  if (!scan) return { claimed: false };
  const stopHeartbeat = startScanLeaseHeartbeat(scan);
  const jobStartedAt = Date.now();

  try {
    const { db } = await connectToDatabase();
    // Persisted targets are revalidated in the worker before any provider
    // query, including archive lookup, so stale/tampered jobs fail closed.
    const ssrf = await validateUrlForScan(scan.url);
    if (!ssrf.isValid || !ssrf.normalizedUrl) throw new Error("Stored crawl target failed validation.");
    const crawlProvider = resolvePersistedCrawlProvider(scan.crawlProvider);
    let crawlRes: CrawlExecutionResult;
    if (crawlProvider === "common-crawl") {
      const admission = await acquireCommonCrawlAdmission({
        jobId: scan._id.toHexString(),
        requesterKey: scan.commonCrawlRequesterKey,
      });
      if (!admission) throw new CommonCrawlAdmissionDeferredError();
      try {
        crawlRes = await runCrawlWithProvider(crawlProvider, ssrf.normalizedUrl, {
          maxPages: boundedMaxPages(scan.requestedMaxPages),
        });
      } finally {
        await admission.release().catch(() => {
          console.error("[ScanJob] Unable to release Common Crawl admission.");
        });
      }
    } else {
      crawlRes = await runCrawlWithProvider(crawlProvider, ssrf.normalizedUrl, {
        maxPages: boundedMaxPages(scan.requestedMaxPages),
      });
    }

    const analysing = await db.collection<ScanDocument>("scans").updateOne(
      { _id: scan._id, leaseId: scan.leaseId, leaseExpiresAt: { $gt: new Date() } },
      { $set: { status: "analysing" } }
    );
    if (analysing.matchedCount !== 1) throw new LeaseLostError();

    const analysisRes = analyzeCrawlResults(crawlRes);
    const completionTime = new Date();
    const pageDocs: PageDocument[] = crawlRes.pages.map((p) => ({
      scanId: scan._id,
      websiteId: scan.websiteId,
      url: p.url,
      normalizedUrl: p.normalizedUrl,
      statusCode: p.statusCode,
      responseTimeMs: p.responseTimeMs,
      contentType: p.contentType,
      pageSizeBytes: p.pageSizeBytes,
      title: p.parsedData?.title,
      metaDescription: p.parsedData?.metaDescription,
      headings: p.parsedData?.headings || { h1: [], h2Count: 0, h3Count: 0 },
      canonicalUrl: p.parsedData?.canonicalUrl,
      isNoindex: p.parsedData?.isNoindex || false,
      isNofollow: p.parsedData?.isNofollow || false,
      hasRobotsTxtDisallow: p.hasRobotsTxtDisallow,
      structuredDataTypes: p.parsedData?.structuredDataTypes || [],
      internalLinks: p.parsedData?.internalLinks || [],
      externalLinks: p.parsedData?.externalLinks || [],
      hreflangs: p.parsedData?.hreflangs || {},
      provenance: p.provenance,
      createdAt: completionTime,
    }));

    const issueDocs: IssueDocument[] = analysisRes.issues.map((issue) => ({
      ...issue,
      scanId: scan._id,
      websiteId: scan.websiteId,
      createdAt: completionTime,
    }));

    const severityCount = (severity: IssueDocument["severity"]) => issueDocs.filter((issue) => issue.severity === severity).length;
    await persistCompletedScan(
      scan,
      pageDocs,
      issueDocs,
      completionTime,
      crawlStatsForResult(crawlRes, scan.attempts),
      {
        totalChecks: analysisRes.scoring.totalChecks,
        passedChecks: analysisRes.scoring.passedChecks,
        failedChecks: analysisRes.scoring.failedChecks,
        criticalIssues: severityCount("critical"),
        highIssues: severityCount("high"),
        mediumIssues: severityCount("medium"),
        lowIssues: severityCount("low"),
        infoIssues: severityCount("info"),
      },
      analysisRes.scoring.score,
      analysisRes.scoring.scoreVersion,
      jobStartedAt
    );

    return { claimed: true, status: "completed" };
  } catch (err) {
    if (isCommonCrawlAdmissionDeferred(err)) {
      await deferScanForCommonCrawlAdmission(scan);
      return { claimed: true, status: "queued" };
    }
    if (!(err instanceof LeaseLostError)) {
      // Do not persist or log target-controlled error strings/URLs.
      console.error("[ScanJob] A crawl attempt failed.");
      await markScanAttemptFailed(scan, err, jobStartedAt);
    }
    return { claimed: true, status: "failed" };
  } finally {
    stopHeartbeat();
  }
}

/** Claims and processes one due scan for an external durable worker. */
export async function processNextQueuedScan(): Promise<{ claimed: boolean; status?: ScanDocument["status"] }> {
  const { db } = await connectToDatabase();
  const candidate = await db
    .collection<ScanDocument>("scans")
    .find({ ...retryableClaimFilter(new Date()) })
    .sort({ createdAt: 1 })
    .project({ _id: 1 })
    .limit(1)
    .next();

  if (!candidate?._id) return { claimed: false };
  return runScanJob(candidate._id.toHexString());
}

async function canAccessScan(db: Db, scan: ScanDocument, access: ScanAccessContext): Promise<boolean> {
  if (scan.websiteId) {
    if (!access.userId) return false;
    try {
      const website = await db.collection("websites").findOne({
        _id: scan.websiteId,
        userId: safeObjectId(access.userId),
      });
      return Boolean(website);
    } catch {
      return false;
    }
  }

  if (scan.ownerUserId) {
    if (!access.userId) return false;
    try {
      return scan.ownerUserId.equals(safeObjectId(access.userId));
    } catch {
      return false;
    }
  }

  // Compatibility for historical authenticated audit/scan records. New scans
  // use `ownerUserId`; unknown legacy ownership fails closed.
  if (scan.clerkUserId) return Boolean(access.userId && scan.clerkUserId === access.userId);
  return verifyOpaqueAccessToken(access.accessToken, scan.anonymousAccessTokenHash);
}

/**
 * Creates a new read-only report capability for the authenticated owner. A
 * replacement deliberately invalidates any earlier copied link: raw tokens
 * are never stored, only their SHA-256 hashes.
 */
export async function createScanShareToken(scanId: string, userId: string): Promise<string | null> {
  const { db } = await connectToDatabase();
  let objectId: ObjectId;
  try {
    objectId = safeObjectId(scanId);
  } catch {
    return null;
  }
  const scan = await db.collection<ScanDocument>("scans").findOne({ _id: objectId });
  if (!scan || scan.status !== "completed" || !(await canAccessScan(db, scan, { userId }))) return null;

  const token = createOpaqueAccessToken();
  const updated = await db.collection<ScanDocument>("scans").updateOne(
    { _id: objectId, status: "completed" },
    { $set: { shareTokenHash: hashOpaqueAccessToken(token), shareCreatedAt: new Date() } }
  );
  return updated.matchedCount === 1 ? token : null;
}

/** Returns a sanitized completed report for one opaque sharing capability. */
export async function getSharedScanReport(token: string): Promise<PublicAuditReport | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const { db } = await connectToDatabase();
  const scan = await db.collection<ScanDocument>("scans").findOne({
    status: "completed",
    shareTokenHash: hashOpaqueAccessToken(token),
  });
  if (!scan?._id) return null;
  const [pages, issues] = await Promise.all([
    db.collection<PageDocument>("pages").find({ scanId: scan._id }).limit(100).toArray(),
    db.collection<IssueDocument>("issues").find({ scanId: scan._id }).toArray(),
  ]);
  return buildPublicAuditReport(scan, pages, issues);
}

/** Returns null for unknown *or unauthorized* scans to avoid resource enumeration. */
export async function getScanByIdForAccess(scanId: string, access: ScanAccessContext = {}): Promise<ScanDocument | null> {
  const { db } = await connectToDatabase();
  try {
    const scan = await db.collection<ScanDocument>("scans").findOne({ _id: safeObjectId(scanId) });
    return scan && (await canAccessScan(db, scan, access)) ? scan : null;
  } catch {
    return null;
  }
}

export async function getScanPagesForAccess(scanId: string, access: ScanAccessContext = {}): Promise<PageDocument[] | null> {
  const scan = await getScanByIdForAccess(scanId, access);
  if (!scan?._id) return null;
  const { db } = await connectToDatabase();
  return db.collection<PageDocument>("pages").find({ scanId: scan._id }).toArray();
}

export async function getScanIssuesForAccess(scanId: string, access: ScanAccessContext = {}): Promise<IssueDocument[] | null> {
  const scan = await getScanByIdForAccess(scanId, access);
  if (!scan?._id) return null;
  const { db } = await connectToDatabase();
  return db.collection<IssueDocument>("issues").find({ scanId: scan._id }).toArray();
}

// Internal-only legacy helpers. Route handlers must use the access-aware variants above.
export async function getScanById(scanId: string): Promise<ScanDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<ScanDocument>("scans").findOne({ _id: safeObjectId(scanId) });
  } catch {
    return null;
  }
}

export async function getScanPages(scanId: string): Promise<PageDocument[]> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<PageDocument>("pages").find({ scanId: safeObjectId(scanId) }).toArray();
  } catch {
    return [];
  }
}

export async function getScanIssues(scanId: string): Promise<IssueDocument[]> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<IssueDocument>("issues").find({ scanId: safeObjectId(scanId) }).toArray();
  } catch {
    return [];
  }
}
