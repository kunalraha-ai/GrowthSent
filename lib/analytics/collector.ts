import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { AnalyticsEventDocument, WebsiteDocument } from "../db/types.js";

export interface RecordAnalyticsEventOptions {
  userId: string;
  websiteId: string;
  anonymousVisitorId: string;
  sessionId: string;
  pageUrl: string;
  referrer?: string;
  userAgent?: string;
}

export function detectDeviceCategory(userAgent?: string): "mobile" | "tablet" | "desktop" {
  if (!userAgent) return "desktop";
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/iphone|ipod|android|blackberry|opera mini|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

export function detectBrowserCategory(userAgent?: string): string {
  if (!userAgent) return "Unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("firefox")) return "Firefox";
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("chrome") && !ua.includes("edg/")) return "Chrome";
  if (ua.includes("safari") && !ua.includes("chrome")) return "Safari";
  return "Other";
}

export async function recordAnalyticsEvent(options: RecordAnalyticsEventOptions): Promise<boolean> {
  const { db } = await connectToDatabase();
  const websiteId = safeObjectId(options.websiteId);
  const userId = safeObjectId(options.userId);

  // Keep the ownership check at the write boundary. This protects future callers
  // from turning a valid ObjectId into cross-tenant analytics data.
  const website = await db.collection<WebsiteDocument>("websites").findOne({ _id: websiteId, userId });
  if (!website) {
    throw new Error("Website not found.");
  }

  const eventDoc: AnalyticsEventDocument = {
    websiteId,
    anonymousVisitorId: options.anonymousVisitorId,
    sessionId: options.sessionId,
    pageUrl: options.pageUrl,
    referrer: options.referrer,
    deviceCategory: detectDeviceCategory(options.userAgent),
    browserCategory: detectBrowserCategory(options.userAgent),
    timestamp: new Date(),
  };

  await db.collection("analyticsEvents").insertOne(eventDoc);
  return true;
}
