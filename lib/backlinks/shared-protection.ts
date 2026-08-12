import { randomUUID } from "node:crypto";
import { connectToDatabase } from "../db/mongodb.js";
import type { BacklinkRow } from "./service.js";

const COLLECTION = "backlinkQueryProtection";
const QUOTA_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 60_000;
const LEASE_TTL_MS = 12_000;
const COALESCED_WAIT_MS = 750;
const REQUESTS_PER_USER_PER_MINUTE = 20;

interface ProtectionDocument {
  _id: string;
  kind: "quota" | "cache";
  count?: number;
  state?: "pending" | "ready";
  leaseId?: string;
  leaseExpiresAt?: Date;
  rows?: BacklinkRow[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class BacklinkProtectionError extends Error {
  constructor(readonly code: "BACKLINK_RATE_LIMIT", message: string) {
    super(message);
    this.name = "BacklinkProtectionError";
  }
}

function duplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export function backlinkSharedCacheKey(domain: string, page: number, pageSize: number): string {
  // This version is part of the key so a semantic change never reuses rows
  // cached under an older internal-link policy.
  return `backlink-cache:v1:external-psl:${domain}:${page}:${pageSize}`;
}

/**
 * Fixed-window, persistent user quota. The API is authenticated, so no IP or
 * session data is stored here. A duplicate-key retry avoids treating a race
 * during the first insert as a false quota denial.
 */
export async function enforceBacklinkRequestQuota(userId: string): Promise<void> {
  const { db } = await connectToDatabase();
  const now = new Date();
  const window = Math.floor(now.getTime() / QUOTA_WINDOW_MS);
  const id = `quota:${userId}:${window}`;
  const collection = db.collection<ProtectionDocument>(COLLECTION);
  const increment = async (upsert: boolean) => collection.updateOne(
    { _id: id, count: { $lt: REQUESTS_PER_USER_PER_MINUTE } },
    {
      $inc: { count: 1 },
      $set: { updatedAt: now },
      $setOnInsert: {
        kind: "quota" as const,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 2 * QUOTA_WINDOW_MS),
      },
    },
    { upsert }
  );

  let result;
  try {
    result = await increment(true);
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    result = await increment(false);
  }
  if (result.matchedCount === 0 && result.upsertedCount === 0) {
    throw new BacklinkProtectionError("BACKLINK_RATE_LIMIT", "Too many backlink preview requests. Please wait a minute and try again.");
  }
}

export interface SharedBacklinkRowsResult {
  rows: BacklinkRow[] | null;
  outcome: "cache_hit" | "loaded" | "coalesced_pending";
}

/**
 * Coalesces equivalent exact-host Data Federation reads across serverless
 * instances. A caller that loses the short lease returns a truthful partial
 * response instead of starting another scan while the first request runs.
 */
export async function getSharedBacklinkRows(
  cacheKey: string,
  load: () => Promise<BacklinkRow[]>
): Promise<SharedBacklinkRowsResult> {
  const { db } = await connectToDatabase();
  const collection = db.collection<ProtectionDocument>(COLLECTION);
  const now = new Date();
  const ready = await collection.findOne({ _id: cacheKey, kind: "cache", state: "ready", expiresAt: { $gt: now } });
  if (ready?.rows) return { rows: ready.rows, outcome: "cache_hit" };

  const leaseId = randomUUID();
  let claimed = false;
  try {
    const result = await collection.findOneAndUpdate(
      {
        _id: cacheKey,
        $or: [
          { expiresAt: { $lte: now } },
          { state: "pending", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          kind: "cache" as const,
          state: "pending" as const,
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
          expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
        $unset: { rows: "" },
      },
      { upsert: true, returnDocument: "after" }
    );
    claimed = result?.leaseId === leaseId;
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }

  if (!claimed) {
    await new Promise<void>((resolve) => setTimeout(resolve, COALESCED_WAIT_MS));
    const completed = await collection.findOne({ _id: cacheKey, kind: "cache", state: "ready", expiresAt: { $gt: new Date() } });
    return completed?.rows
      ? { rows: completed.rows, outcome: "cache_hit" }
      : { rows: null, outcome: "coalesced_pending" };
  }

  try {
    const rows = await load();
    await collection.updateOne(
      { _id: cacheKey, leaseId },
      {
        $set: {
          state: "ready" as const,
          rows,
          expiresAt: new Date(Date.now() + CACHE_TTL_MS),
          updatedAt: new Date(),
        },
        $unset: { leaseId: "", leaseExpiresAt: "" },
      }
    );
    return { rows, outcome: "loaded" };
  } catch (error) {
    await collection.deleteOne({ _id: cacheKey, leaseId }).catch(() => undefined);
    throw error;
  }
}
