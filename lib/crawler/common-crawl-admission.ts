import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { connectToDatabase } from "../db/mongodb.js";
import { isCommonCrawlRequesterKey } from "../security/common-crawl-requester.js";

const ADMISSION_COLLECTION = "commonCrawlAdmissions";
const GLOBAL_SLOT_COUNT = 2;
const LEASE_DURATION_MS = 2 * 60 * 1000;
export const COMMON_CRAWL_ADMISSION_RETRY_DELAY_MS = 15_000;

interface AdmissionDocument {
  _id: string;
  kind: "requester" | "slot";
  jobId: string;
  leaseId: string;
  requesterKey: string;
  leaseExpiresAt: Date;
  updatedAt: Date;
}

export class CommonCrawlAdmissionError extends Error {
  constructor(
    readonly code: "COMMON_CRAWL_ADMISSION_DEFERRED" | "COMMON_CRAWL_ADMISSION_IDENTITY_INVALID",
    readonly retryable: boolean
  ) {
    super("Common Crawl admission could not be completed.");
    this.name = "CommonCrawlAdmissionError";
  }
}

export class CommonCrawlAdmissionDeferredError extends CommonCrawlAdmissionError {
  constructor() {
    super("COMMON_CRAWL_ADMISSION_DEFERRED", true);
    this.name = "CommonCrawlAdmissionDeferredError";
  }
}

export function isCommonCrawlAdmissionDeferred(error: unknown): error is CommonCrawlAdmissionDeferredError {
  return error instanceof CommonCrawlAdmissionDeferredError;
}

export function isCommonCrawlAdmissionError(error: unknown): error is CommonCrawlAdmissionError {
  return error instanceof CommonCrawlAdmissionError;
}

export interface CommonCrawlAdmissionLease {
  release(): Promise<void>;
}

/**
 * Acquires one durable global archive-work slot and one durable requester
 * lease. `_id` is MongoDB's built-in unique index, so this works across
 * worker processes without a schema/index migration. A crashed worker is
 * released by lease expiry; a normal worker releases immediately after WARC
 * retrieval, before SEO analysis/persistence begins.
 */
export async function acquireCommonCrawlAdmission(input: {
  jobId: string;
  requesterKey: unknown;
}): Promise<CommonCrawlAdmissionLease | null> {
  if (!isCommonCrawlRequesterKey(input.requesterKey) || !/^[a-zA-Z0-9_]{12,128}$/.test(input.jobId)) {
    throw new CommonCrawlAdmissionError("COMMON_CRAWL_ADMISSION_IDENTITY_INVALID", false);
  }

  const { db } = await connectToDatabase();
  const leaseId = randomBytes(24).toString("hex");
  const requesterDocumentId = `requester:${input.requesterKey}`;
  const requesterLease = await tryAcquireLease(db, {
    documentId: requesterDocumentId,
    kind: "requester",
    jobId: input.jobId,
    leaseId,
    requesterKey: input.requesterKey,
  });
  if (!requesterLease) return null;

  for (let slot = 0; slot < GLOBAL_SLOT_COUNT; slot++) {
    const slotDocumentId = `slot:${slot}`;
    const slotLease = await tryAcquireLease(db, {
      documentId: slotDocumentId,
      kind: "slot",
      jobId: input.jobId,
      leaseId,
      requesterKey: input.requesterKey,
    });
    if (slotLease) {
      return {
        release: async () => {
          await Promise.all([
            releaseRequesterLease(db, requesterDocumentId, input.jobId, leaseId),
            releaseSlotLease(db, slotDocumentId, input.jobId, leaseId),
          ]);
        },
      };
    }
  }

  await releaseRequesterLease(db, requesterDocumentId, input.jobId, leaseId).catch(() => undefined);
  return null;
}

async function tryAcquireLease(
  db: Db,
  input: {
    documentId: string;
    kind: AdmissionDocument["kind"];
    jobId: string;
    leaseId: string;
    requesterKey: string;
  }
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
  const collection = db.collection<AdmissionDocument>(ADMISSION_COLLECTION);
  const claimed = await collection.findOneAndUpdate(
    {
      _id: input.documentId,
      kind: input.kind,
      $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: { $exists: false } }],
    },
    {
      $set: {
        jobId: input.jobId,
        leaseId: input.leaseId,
        requesterKey: input.requesterKey,
        leaseExpiresAt,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );
  if (claimed?.leaseId === input.leaseId) return true;
  if (claimed) return false;

  try {
    await collection.insertOne({
      _id: input.documentId,
      kind: input.kind,
      jobId: input.jobId,
      leaseId: input.leaseId,
      requesterKey: input.requesterKey,
      leaseExpiresAt,
      updatedAt: now,
    });
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

async function releaseRequesterLease(db: Db, documentId: string, jobId: string, leaseId: string): Promise<void> {
  // Requester identities are one-shot locks. Delete with the exact ownership
  // fence so normal traffic does not leave an unbounded document per IP/user.
  await db.collection<AdmissionDocument>(ADMISSION_COLLECTION).deleteOne({
    _id: documentId,
    kind: "requester",
    jobId,
    leaseId,
  });
}

async function releaseSlotLease(
  db: Db,
  documentId: string,
  jobId: string,
  leaseId: string
): Promise<void> {
  await db.collection<AdmissionDocument>(ADMISSION_COLLECTION).updateOne(
    { _id: documentId, kind: "slot", jobId, leaseId },
    {
      $set: { leaseExpiresAt: new Date(0), updatedAt: new Date() },
      $unset: { jobId: "", leaseId: "", requesterKey: "" },
    }
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}
