import { createHmac } from "node:crypto";
import type { ClientSession, Db, MongoClient } from "mongodb";
import type { CrawlJobDocument, ScanStatus } from "../db/types.js";
import { withMongoOperationPhase } from "../db/mongo-diagnostics.js";
import { registrableDomain } from "../domain/registrable.js";

const ADMISSION_COLLECTION = "crawlAdmission";
const ACTIVE_STATUSES: ScanStatus[] = ["queued", "crawling", "analysing"];
const WINDOW_MS = 60 * 60 * 1000;
const TARGET_COOLDOWN_MS = 60 * 1000;
const ACTIVE_CLAIM_MS = 60 * 60 * 1000;
const ADMISSION_TRANSACTION_MAX_ATTEMPTS = 3;

export const EXTERNAL_MVP_CRAWL_ADMISSION = {
  authenticatedPerHour: 8,
  anonymousPerHour: 2,
  queueCap: 25,
  targetCooldownMs: TARGET_COOLDOWN_MS,
} as const;

export type CrawlAdmissionErrorCode = "CRAWL_QUOTA_EXCEEDED" | "CRAWL_TARGET_COOLDOWN" | "CRAWL_QUEUE_FULL" | "CRAWL_DUPLICATE" | "CRAWL_ADMISSION_CONFIG";

export class CrawlAdmissionError extends Error {
  constructor(readonly code: CrawlAdmissionErrorCode, message: string) {
    super(message);
    this.name = "CrawlAdmissionError";
  }
}

interface AdmissionDocument {
  _id: string;
  kind: "quota" | "target" | "active" | "queue";
  count?: number;
  activeCount?: number;
  jobId?: string;
  actorKind?: "authenticated" | "anonymous";
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlAdmissionResult {
  reusedJobId?: string;
  reusedStatus?: ScanStatus;
  queueSlotClaimed: boolean;
  activeClaimKey?: string;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

/**
 * Signals an optimistic compare-and-set race. Throwing this ends the current
 * transaction; it is never handled from inside a transaction callback.
 */
class AdmissionTransactionContentionError extends Error {
  constructor() {
    super("Crawl admission transaction conflicted with another request.");
    this.name = "AdmissionTransactionContentionError";
  }
}

function canRetryAdmissionTransaction(error: unknown): boolean {
  return isDuplicateKey(error) || error instanceof AdmissionTransactionContentionError;
}

/**
 * A duplicate key can make MongoDB abort a transaction immediately. Retry the
 * entire transaction with a fresh session instead of issuing another command
 * against the aborted session.
 */
export async function runAdmissionTransactionWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ADMISSION_TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!canRetryAdmissionTransaction(error) || attempt === ADMISSION_TRANSACTION_MAX_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

function admissionSecret(): string | undefined {
  return process.env.CRAWL_ADMISSION_SECRET?.trim() || process.env.SESSION_SECRET?.trim();
}

export function createAnonymousAdmissionActorKey(ip: string): string {
  const secret = admissionSecret();
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
      throw new CrawlAdmissionError("CRAWL_ADMISSION_CONFIG", "Anonymous audit admission is not configured.");
    }
    // Local/test use only; production must provide one of the server secrets.
    return `anonymous:${createHmac("sha256", "growthsent-local-admission-only").update(ip).digest("hex")}`;
  }
  return `anonymous:${createHmac("sha256", secret).update(ip).digest("hex")}`;
}

export function createCrawlAdmissionTargetKey(url: string): string {
  const hostname = new URL(url).hostname;
  return registrableDomain(hostname) || hostname.toLowerCase();
}

export function isActiveCrawlStatus(status: ScanStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function quotaDocumentId(actorKey: string, now: Date): string {
  return `quota:${actorKey}:${Math.floor(now.getTime() / WINDOW_MS)}`;
}

function activeClaimDocumentId(actorKey: string, targetKey: string): string {
  return `active:${actorKey}:${targetKey}`;
}

function activeClaimDocument(
  claimKey: string,
  job: CrawlJobDocument,
  actorKind: "authenticated" | "anonymous",
  now: Date
): AdmissionDocument {
  return {
    _id: claimKey,
    kind: "active",
    jobId: job.jobId,
    actorKind,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + ACTIVE_CLAIM_MS),
  };
}

async function claimActiveJob(
  db: Db,
  session: ClientSession,
  claimKey: string,
  job: CrawlJobDocument,
  actorKind: "authenticated" | "anonymous",
  now: Date
): Promise<CrawlAdmissionResult | null> {
  const claims = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  const jobs = db.collection<CrawlJobDocument>("crawlJobs");
  const existing = await withMongoOperationPhase("audit_admission_active_claim_lookup", () =>
    claims.findOne({ _id: claimKey }, { session, projection: { jobId: 1, updatedAt: 1 } })
  );
  if (!existing) {
    // A concurrent first insert may cause E11000. It is deliberately allowed
    // to abort this callback so the retry wrapper starts a fresh transaction.
    await withMongoOperationPhase("audit_admission_active_claim_insert", () =>
      claims.insertOne(activeClaimDocument(claimKey, job, actorKind, now), { session })
    );
    return null;
  }

  const existingJob = existing.jobId
    ? await withMongoOperationPhase("audit_admission_active_claim_lookup", () =>
        jobs.findOne({ jobId: existing.jobId }, { session, projection: { jobId: 1, status: 1 } })
      )
    : null;
  if (existingJob && isActiveCrawlStatus(existingJob.status)) {
    if (actorKind === "authenticated") {
      return { reusedJobId: existingJob.jobId, reusedStatus: existingJob.status, queueSlotClaimed: false };
    }
    throw new CrawlAdmissionError("CRAWL_DUPLICATE", "An audit for this website is already queued or running.");
  }

  // A stale claim is replaced with compare-and-set semantics. A race here
  // aborts and retries the whole transaction rather than continuing on a
  // session whose transaction may no longer be active.
  const replaced = await withMongoOperationPhase("audit_admission_active_claim_recovery", () => claims.updateOne(
    { _id: claimKey, updatedAt: existing.updatedAt },
    {
      $set: {
        kind: "active",
        jobId: job.jobId,
        actorKind,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ACTIVE_CLAIM_MS),
      },
    },
    { session }
  ));
  if (replaced.matchedCount !== 1) throw new AdmissionTransactionContentionError();
  return null;
}

async function claimQuota(
  db: Db,
  session: ClientSession,
  actorKey: string,
  actorKind: "authenticated" | "anonymous",
  now: Date
): Promise<void> {
  const limit = actorKind === "authenticated"
    ? EXTERNAL_MVP_CRAWL_ADMISSION.authenticatedPerHour
    : EXTERNAL_MVP_CRAWL_ADMISSION.anonymousPerHour;
  const collection = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  const id = quotaDocumentId(actorKey, now);
  const existing = await withMongoOperationPhase("audit_admission_quota_lookup", () =>
    collection.findOne({ _id: id }, { session, projection: { count: 1, updatedAt: 1 } })
  );
  if (!existing) {
    await withMongoOperationPhase("audit_admission_quota_update", () => collection.insertOne({
      _id: id,
      kind: "quota",
      count: 1,
      actorKind,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 2 * WINDOW_MS),
    }, { session }));
    return;
  }

  const count = existing.count || 0;
  if (count >= limit) throw new CrawlAdmissionError("CRAWL_QUOTA_EXCEEDED", "Audit request limit reached. Please try again later.");
  const updated = await withMongoOperationPhase("audit_admission_quota_update", () => collection.updateOne(
    { _id: id, updatedAt: existing.updatedAt },
    { $inc: { count: 1 }, $set: { updatedAt: now } },
    { session }
  ));
  if (updated.matchedCount !== 1) throw new AdmissionTransactionContentionError();
}

async function claimTargetCooldown(db: Db, session: ClientSession, targetKey: string, now: Date): Promise<void> {
  const collection = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  const id = `target:${targetKey}`;
  const existing = await withMongoOperationPhase("audit_admission_target_cooldown_lookup", () =>
    collection.findOne({ _id: id }, { session, projection: { expiresAt: 1, updatedAt: 1 } })
  );
  if (!existing) {
    await withMongoOperationPhase("audit_admission_target_cooldown_update", () => collection.insertOne({
      _id: id,
      kind: "target",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + TARGET_COOLDOWN_MS),
    }, { session }));
    return;
  }

  if (existing.expiresAt && existing.expiresAt > now) {
    throw new CrawlAdmissionError("CRAWL_TARGET_COOLDOWN", "This website was audited recently. Please wait a minute before requesting another audit.");
  }
  const updated = await withMongoOperationPhase("audit_admission_target_cooldown_update", () => collection.updateOne(
    { _id: id, updatedAt: existing.updatedAt },
    { $set: { kind: "target", updatedAt: now, expiresAt: new Date(now.getTime() + TARGET_COOLDOWN_MS) } },
    { session }
  ));
  if (updated.matchedCount !== 1) throw new AdmissionTransactionContentionError();
}

async function claimQueueSlot(db: Db, session: ClientSession, now: Date): Promise<void> {
  const collection = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  const id = "queue:external-mvp";
  const existing = await withMongoOperationPhase("audit_admission_queue_lookup", () =>
    collection.findOne({ _id: id }, { session, projection: { activeCount: 1, updatedAt: 1 } })
  );
  if (!existing) {
    await withMongoOperationPhase("audit_admission_queue_update", () => collection.insertOne({
      _id: id,
      kind: "queue",
      activeCount: 1,
      createdAt: now,
      updatedAt: now,
    }, { session }));
    return;
  }

  const activeCount = existing.activeCount || 0;
  if (activeCount >= EXTERNAL_MVP_CRAWL_ADMISSION.queueCap) {
    throw new CrawlAdmissionError("CRAWL_QUEUE_FULL", "The audit queue is temporarily full. Please try again shortly.");
  }
  const updated = await withMongoOperationPhase("audit_admission_queue_update", () => collection.updateOne(
    { _id: id, updatedAt: existing.updatedAt },
    { $inc: { activeCount: 1 }, $set: { updatedAt: now } },
    { session }
  ));
  if (updated.matchedCount !== 1) throw new AdmissionTransactionContentionError();
}

/**
 * Runs admission and job creation inside one MongoDB transaction. The active
 * claim is the atomic actor+target dedupe boundary; quota, cooldown, and queue
 * slot mutations roll back together if the job is not inserted.
 */
export async function admitAndInsertCrawlJob(
  client: MongoClient,
  db: Db,
  job: CrawlJobDocument,
  requestIp?: string
): Promise<CrawlAdmissionResult> {
  const now = new Date();
  const actorKind = job.clerkUserId ? "authenticated" : "anonymous";
  const actorKey = job.clerkUserId ? `user:${job.clerkUserId}` : createAnonymousAdmissionActorKey(requestIp || "unknown");
  const targetKey = createCrawlAdmissionTargetKey(job.url);
  const claimKey = activeClaimDocumentId(actorKey, targetKey);

  return withMongoOperationPhase("audit_admission_transaction", () => runAdmissionTransactionWithRetry(() =>
    client.withSession((session) => session.withTransaction(async () => {
      const existingAdmission = await claimActiveJob(db, session, claimKey, job, actorKind, now);
      if (existingAdmission) return existingAdmission;

      await claimQuota(db, session, actorKey, actorKind, now);
      await claimTargetCooldown(db, session, targetKey, now);
      await claimQueueSlot(db, session, now);
      await withMongoOperationPhase("audit_admission_job_enqueue", () =>
        db.collection<CrawlJobDocument>("crawlJobs").insertOne(
          { ...job, admissionQueueSlot: true, admissionClaimKey: claimKey },
          { session }
        )
      );
      return { queueSlotClaimed: true, activeClaimKey: claimKey };
    }))
  ));
}

/** Releases durable admission state only after a terminal job transition. */
export async function releaseCrawlAdmission(
  db: Db,
  job: Pick<CrawlJobDocument, "jobId" | "admissionQueueSlot" | "admissionClaimKey">,
  session?: ClientSession
): Promise<void> {
  const options = session ? { session } : undefined;
  const claims = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  if (job.admissionClaimKey) {
    await claims.deleteOne({ _id: job.admissionClaimKey, jobId: job.jobId }, options);
  }
  if (job.admissionQueueSlot) {
    await claims.updateOne(
      { _id: "queue:external-mvp", activeCount: { $gt: 0 } },
      { $inc: { activeCount: -1 }, $set: { updatedAt: new Date() } },
      options
    );
  }
}

export interface CrawlQueueHealth {
  pendingApproximation: number;
  oldestPendingAgeMs: number | null;
  activeCount: number;
  staleLeaseCount: number;
}

/** Bounded internal-only health snapshot; it never returns URLs or owners. */
export async function getCrawlQueueHealth(db: Db): Promise<CrawlQueueHealth> {
  const now = new Date();
  const [pending, oldest, stale, state] = await Promise.all([
    db.collection<CrawlJobDocument>("crawlJobs").countDocuments({ status: "queued" }, { limit: EXTERNAL_MVP_CRAWL_ADMISSION.queueCap + 1 }),
    db.collection<CrawlJobDocument>("crawlJobs").find({ status: "queued" }, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).next(),
    db.collection<CrawlJobDocument>("crawlJobs").countDocuments({ status: { $in: ["crawling", "analysing"] }, leaseExpiresAt: { $lte: now } }, { limit: EXTERNAL_MVP_CRAWL_ADMISSION.queueCap + 1 }),
    db.collection<AdmissionDocument>(ADMISSION_COLLECTION).findOne({ _id: "queue:external-mvp" }, { projection: { activeCount: 1 } }),
  ]);
  return {
    pendingApproximation: pending,
    oldestPendingAgeMs: oldest?.createdAt ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) : null,
    activeCount: state?.activeCount || 0,
    staleLeaseCount: stale,
  };
}
