import type { ScanStatus } from "../db/types.js";
import { connectToDatabase } from "../db/mongodb.js";
import { AuditService } from "../services/audit.service.js";

const SLOT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_SLOT_COUNT = 3;
const MAX_SLOT_COUNT = 5;

interface ImmediateAuditSlot {
  _id: string;
  jobId?: string;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

type ProcessAuditJob = (jobId: string) => Promise<{
  claimed: boolean;
  status?: ScanStatus;
  attempt?: number;
  queueAgeMs?: number;
}>;

export interface ImmediateAuditDispatchOptions {
  acquireSlot?: (jobId: string) => Promise<string | null>;
  releaseSlot?: (slotId: string, jobId: string) => Promise<void>;
  processJob?: ProcessAuditJob;
}

export interface ImmediateAuditDispatchResult {
  dispatched: boolean;
  claimed: boolean;
  status?: ScanStatus;
  attempt?: number;
  queueAgeMs?: number;
}

function slotCount(value = process.env.AUDIT_IMMEDIATE_DISPATCH_SLOTS): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SLOT_COUNT;
  return Math.max(1, Math.min(MAX_SLOT_COUNT, parsed));
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

/**
 * Claims one of a small set of leased execution slots. This is deliberately
 * separate from audit admission: it limits concurrent execution across Vercel
 * function instances while preserving the existing queue and per-site lease.
 */
export async function acquireImmediateAuditSlot(jobId: string): Promise<string | null> {
  const { db } = await connectToDatabase();
  const slots = db.collection<ImmediateAuditSlot>("crawlWorkerSlots");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SLOT_LEASE_MS);

  for (let index = 1; index <= slotCount(); index++) {
    const slotId = `immediate-audit-${index}`;
    try {
      const slot = await slots.findOneAndUpdate(
        {
          _id: slotId,
          $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
        },
        {
          $set: { jobId, expiresAt, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: "after" }
      );
      if (slot?.jobId === jobId) return slotId;
    } catch (error) {
      // Another function can create the same empty slot first. That slot is
      // unavailable to this job, so try the next bounded slot instead.
      if (!isDuplicateKey(error)) throw error;
    }
  }

  return null;
}

export async function releaseImmediateAuditSlot(slotId: string, jobId: string): Promise<void> {
  const { db } = await connectToDatabase();
  await db.collection<ImmediateAuditSlot>("crawlWorkerSlots").updateOne(
    { _id: slotId, jobId },
    {
      $unset: { jobId: "" },
      $set: { expiresAt: new Date(), updatedAt: new Date() },
    }
  );
}

/**
 * Runs only the named job after its API response has been sent. A lease makes
 * duplicate dispatches and the recovery scheduler harmless: at most one of
 * them can claim the durable audit job.
 */
export async function dispatchImmediateAuditJob(
  jobId: string,
  options: ImmediateAuditDispatchOptions = {}
): Promise<ImmediateAuditDispatchResult> {
  const acquireSlot = options.acquireSlot ?? acquireImmediateAuditSlot;
  const releaseSlot = options.releaseSlot ?? releaseImmediateAuditSlot;
  const processJob = options.processJob ?? AuditService.processCrawlJob.bind(AuditService);
  const slotId = await acquireSlot(jobId);
  if (!slotId) {
    console.info("[audit-dispatch] Immediate audit start deferred because execution capacity is full.");
    return { dispatched: false, claimed: false };
  }

  const startedAtMs = Date.now();
  try {
    const result = await processJob(jobId);
    console.info("[audit-dispatch] Immediate audit attempt finished.", {
      claimed: result.claimed,
      outcome: result.status || "none",
      attempt: result.attempt ?? null,
      queueAgeMs: result.queueAgeMs ?? null,
      durationMs: Date.now() - startedAtMs,
    });
    return { dispatched: true, ...result };
  } finally {
    await releaseSlot(slotId, jobId).catch(() => {
      console.error("[audit-dispatch] Unable to release an immediate audit execution slot.");
    });
  }
}
