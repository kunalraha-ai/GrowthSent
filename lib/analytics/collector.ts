import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb";
import { AnalyticsEventDocument } from "../db/types";

export interface RecordAnalyticsEventOptions {
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

  const eventDoc: AnalyticsEventDocument = {
    websiteId: new ObjectId(options.websiteId),
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
