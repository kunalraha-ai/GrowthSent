import type { ClientSession, Db, Filter, ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { ScanDocument, WebsiteDocument } from "../db/types.js";

export interface CreateWebsiteOptions {
  userId: string;
  urlOrHostname: string;
  displayName?: string;
  monitoringEnabled?: boolean;
  monitoringFrequency?: "daily" | "weekly";
}

type WebsiteTimingOutcome = "started" | "completed" | "failed";

function safeWebsiteErrorMetadata(error: unknown): { errorName: string; errorCode?: string | number } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorCode = typeof error === "object" && error && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof errorCode === "string" || typeof errorCode === "number"
    ? { errorName, errorCode }
    : { errorName };
}

function logWebsiteTiming(
  phase: "db_connection" | "owner_validation" | "website_query",
  startedAt: string,
  startedMs: number,
  outcome: WebsiteTimingOutcome,
  extra: Record<string, unknown> = {}
): void {
  console.info("[websites] timing", {
    phase,
    startedAt,
    elapsedMs: Date.now() - startedMs,
    outcome,
    ...extra,
  });
}

export async function deleteScansAndChildrenInTransaction(
  db: Db,
  scanFilter: Filter<ScanDocument>,
  session: ClientSession
): Promise<void> {
  const scanIds: ObjectId[] = [];
  const deleteChildren = async () => {
    if (scanIds.length === 0) return;
    const ids = scanIds.splice(0, scanIds.length);
    await db.collection("pages").deleteMany({ scanId: { $in: ids } }, { session });
    await db.collection("issues").deleteMany({ scanId: { $in: ids } }, { session });
  };

  const cursor = db.collection<ScanDocument>("scans").find(scanFilter, {
    session,
    projection: { _id: 1 },
    batchSize: 500,
  });
  for await (const scan of cursor) {
    if (scan._id) scanIds.push(scan._id);
    if (scanIds.length >= 500) await deleteChildren();
  }
  await deleteChildren();
  await db.collection<ScanDocument>("scans").deleteMany(scanFilter, { session });
}

/**
 * Removes every active legacy child collection before deleting a saved website.
 * The caller must already be inside a MongoDB transaction.
 */
export async function deleteWebsiteDataInTransaction(
  db: Db,
  websiteId: ObjectId,
  userId: ObjectId,
  session: ClientSession
): Promise<boolean> {
  const website = await db.collection<WebsiteDocument>("websites").findOne(
    { _id: websiteId, userId },
    { session, projection: { _id: 1 } }
  );
  if (!website) return false;

  // Delete dependents before their parent. Direct websiteId deletes cover old
  // records; scanId deletes cover historical page/issue documents without one.
  await deleteScansAndChildrenInTransaction(db, { websiteId }, session);
  await db.collection("pages").deleteMany({ websiteId }, { session });
  await db.collection("issues").deleteMany({ websiteId }, { session });
  await db.collection("crawlJobs").deleteMany({ websiteId }, { session });
  await db.collection("crawlSnapshots").deleteMany({ websiteId }, { session });
  await db.collection("seoIssueHistory").deleteMany({ websiteId }, { session });
  await db.collection("monitoringSnapshots").deleteMany({ websiteId }, { session });
  await db.collection("analyticsEvents").deleteMany({ websiteId }, { session });
  await db.collection("analyticsAggregates").deleteMany({ websiteId }, { session });
  await db.collection("integrations").deleteMany({ websiteId }, { session });
  await db.collection("googleOAuthStates").deleteMany({ websiteId }, { session });
  await db.collection("notifications").deleteMany({ websiteId }, { session });

  const deleted = await db.collection<WebsiteDocument>("websites").deleteOne({ _id: websiteId, userId }, { session });
  if (deleted.deletedCount !== 1) throw new Error("Website deletion lost ownership consistency.");
  return true;
}

export async function createWebsite(options: CreateWebsiteOptions): Promise<WebsiteDocument> {
  let hostname = options.urlOrHostname.trim().toLowerCase();

  try {
    if (hostname.startsWith("http://") || hostname.startsWith("https://")) {
      hostname = new URL(hostname).hostname;
    } else {
      hostname = new URL(`https://${hostname}`).hostname;
    }
  } catch {
    throw new Error("Invalid hostname or URL provided.");
  }

  const { db } = await connectToDatabase();
  const userObjId = safeObjectId(options.userId);

  const existing = await db.collection<WebsiteDocument>("websites").findOne({
    userId: userObjId,
    hostname,
  });
  if (existing) return existing;

  const now = new Date();
  const websiteDoc: WebsiteDocument = {
    userId: userObjId,
    hostname,
    displayName: options.displayName || hostname,
    verifiedStatus: false,
    // Monitoring has no production scheduler/execution path in this MVP. Keep
    // the underlying field for future work, but never imply a new site is being
    // actively monitored.
    monitoringEnabled: options.monitoringEnabled ?? false,
    monitoringFrequency: options.monitoringFrequency || "weekly",
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await db.collection<WebsiteDocument>("websites").insertOne(websiteDoc);
    return { ...websiteDoc, _id: res.insertedId };
  } catch (error: unknown) {
    // Once the manually-audited unique index is provisioned, concurrent
    // creates can race. Return the existing owned site instead of surfacing a
    // transient duplicate-key error to the user.
    if ((error as { code?: number })?.code === 11000) {
      const duplicate = await db.collection<WebsiteDocument>("websites").findOne({ userId: userObjId, hostname });
      if (duplicate) return duplicate;
    }
    throw error;
  }
}

export async function getUserWebsites(userId: string): Promise<WebsiteDocument[]> {
  const ownerValidationStartedAt = new Date().toISOString();
  const ownerValidationStartedMs = Date.now();
  let ownerId: ObjectId;
  try {
    ownerId = safeObjectId(userId);
    logWebsiteTiming("owner_validation", ownerValidationStartedAt, ownerValidationStartedMs, "completed", {
      ownerIdValid: true,
    });
  } catch (error) {
    logWebsiteTiming("owner_validation", ownerValidationStartedAt, ownerValidationStartedMs, "failed", {
      ownerIdValid: false,
      ...safeWebsiteErrorMetadata(error),
    });
    throw error;
  }

  const connectionStartedAt = new Date().toISOString();
  const connectionStartedMs = Date.now();
  let db: Db;
  try {
    ({ db } = await connectToDatabase());
    logWebsiteTiming("db_connection", connectionStartedAt, connectionStartedMs, "completed", {
      mongoUriConfigured: Boolean(process.env.MONGODB_URI?.trim()),
      mongoDbNameConfigured: Boolean(process.env.MONGODB_DB_NAME?.trim()),
    });
  } catch (error) {
    logWebsiteTiming("db_connection", connectionStartedAt, connectionStartedMs, "failed", {
      mongoUriConfigured: Boolean(process.env.MONGODB_URI?.trim()),
      mongoDbNameConfigured: Boolean(process.env.MONGODB_DB_NAME?.trim()),
      ...safeWebsiteErrorMetadata(error),
    });
    throw error;
  }

  const queryStartedAt = new Date().toISOString();
  const queryStartedMs = Date.now();
  try {
    const websites = await db
      .collection<WebsiteDocument>("websites")
      .find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .toArray();
    logWebsiteTiming("website_query", queryStartedAt, queryStartedMs, "completed", { websiteCount: websites.length });
    return websites;
  } catch (error) {
    logWebsiteTiming("website_query", queryStartedAt, queryStartedMs, "failed", safeWebsiteErrorMetadata(error));
    throw error;
  }
}

export async function getWebsiteById(websiteId: string, userId: string): Promise<WebsiteDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<WebsiteDocument>("websites").findOne({
      _id: safeObjectId(websiteId),
      userId: safeObjectId(userId),
    });
  } catch {
    return null;
  }
}

export async function deleteWebsite(websiteId: string, userId: string): Promise<boolean> {
  let webObjId: ObjectId;
  let userObjId: ObjectId;
  try {
    webObjId = safeObjectId(websiteId);
    userObjId = safeObjectId(userId);
  } catch {
    return false;
  }

  const { client, db } = await connectToDatabase();
  const session = client.startSession();
  let deleted = false;
  try {
    await session.withTransaction(async () => {
      deleted = await deleteWebsiteDataInTransaction(db, webObjId, userObjId, session);
    });
    return deleted;
  } finally {
    await session.endSession();
  }
}

export async function getWebsiteScans(websiteId: string): Promise<ScanDocument[]> {
  const { db } = await connectToDatabase();
  try {
    return await db
      .collection<ScanDocument>("scans")
      .find({ websiteId: safeObjectId(websiteId) })
      .sort({ createdAt: -1 })
      .toArray();
  } catch {
    return [];
  }
}
