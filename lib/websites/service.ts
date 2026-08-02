import { ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb";
import { WebsiteDocument, ScanDocument } from "../db/types";
import { createScan } from "../scans/service";

export interface CreateWebsiteOptions {
  userId: string;
  urlOrHostname: string;
  displayName?: string;
  monitoringEnabled?: boolean;
  monitoringFrequency?: "daily" | "weekly";
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

  if (existing) {
    return existing;
  }

  const now = new Date();
  const websiteDoc: WebsiteDocument = {
    userId: userObjId,
    hostname,
    displayName: options.displayName || hostname,
    verifiedStatus: false,
    monitoringEnabled: options.monitoringEnabled ?? true,
    monitoringFrequency: options.monitoringFrequency || "weekly",
    createdAt: now,
    updatedAt: now,
  };

  const res = await db.collection("websites").insertOne(websiteDoc);
  websiteDoc._id = res.insertedId;

  return websiteDoc;
}

export async function getUserWebsites(userId: string): Promise<WebsiteDocument[]> {
  const { db } = await connectToDatabase();
  return await db
    .collection<WebsiteDocument>("websites")
    .find({ userId: new ObjectId(userId) })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function getWebsiteById(websiteId: string, userId: string): Promise<WebsiteDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<WebsiteDocument>("websites").findOne({
      _id: new ObjectId(websiteId),
      userId: new ObjectId(userId),
    });
  } catch {
    return null;
  }
}

export async function deleteWebsite(websiteId: string, userId: string): Promise<boolean> {
  const { db } = await connectToDatabase();
  const webObjId = new ObjectId(websiteId);
  const userObjId = new ObjectId(userId);

  const website = await db.collection<WebsiteDocument>("websites").findOne({ _id: webObjId, userId: userObjId });
  if (!website) return false;

  await db.collection("websites").deleteOne({ _id: webObjId });
  await db.collection("scans").deleteMany({ websiteId: webObjId });
  await db.collection("pages").deleteMany({ websiteId: webObjId });
  await db.collection("issues").deleteMany({ websiteId: webObjId });
  await db.collection("monitoringSnapshots").deleteMany({ websiteId: webObjId });
  await db.collection("analyticsEvents").deleteMany({ websiteId: webObjId });
  await db.collection("analyticsAggregates").deleteMany({ websiteId: webObjId });

  return true;
}

export async function getWebsiteScans(websiteId: string): Promise<ScanDocument[]> {
  const { db } = await connectToDatabase();
  return await db
    .collection<ScanDocument>("scans")
    .find({ websiteId: new ObjectId(websiteId) })
    .sort({ createdAt: -1 })
    .toArray();
}
