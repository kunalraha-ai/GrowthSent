import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb";
import { AnalyticsEventDocument } from "../db/types";

export interface AnalyticsSummaryResult {
  totalPageviews: number;
  uniqueVisitors: number;
  uniqueSessions: number;
  topPages: Array<{ pageUrl: string; views: number; percentage: number }>;
  topReferrers: Array<{ referrer: string; count: number }>;
  deviceBreakdown: Record<string, number>;
  trend: Array<{ date: string; pageviews: number; visitors: number }>;
}

export async function getAnalyticsSummary(
  websiteId: string,
  days: number = 30
): Promise<AnalyticsSummaryResult> {
  const { db } = await connectToDatabase();
  const webObjId = new ObjectId(websiteId);
  const startDate = new Date(Date.now() - days * 24 * 3600 * 1000);

  const events = await db
    .collection<AnalyticsEventDocument>("analyticsEvents")
    .find({ websiteId: webObjId, timestamp: { $gte: startDate } })
    .toArray();

  const totalPageviews = events.length;
  const visitorsSet = new Set<string>();
  const sessionsSet = new Set<string>();

  const pageCounts: Record<string, number> = {};
  const referrerCounts: Record<string, number> = {};
  const deviceBreakdown: Record<string, number> = { desktop: 0, mobile: 0, tablet: 0 };
  const dateMap: Record<string, { pageviews: number; visitors: Set<string> }> = {};

  for (const ev of events) {
    visitorsSet.add(ev.anonymousVisitorId);
    sessionsSet.add(ev.sessionId);

    // Page views
    pageCounts[ev.pageUrl] = (pageCounts[ev.pageUrl] || 0) + 1;

    // Referrers
    if (ev.referrer) {
      try {
        const refHost = new URL(ev.referrer).hostname;
        referrerCounts[refHost] = (referrerCounts[refHost] || 0) + 1;
      } catch {
        referrerCounts[ev.referrer] = (referrerCounts[ev.referrer] || 0) + 1;
      }
    } else {
      referrerCounts["Direct / None"] = (referrerCounts["Direct / None"] || 0) + 1;
    }

    // Devices
    const dev = ev.deviceCategory || "desktop";
    deviceBreakdown[dev] = (deviceBreakdown[dev] || 0) + 1;

    // Trend
    const dateStr = ev.timestamp.toISOString().split("T")[0];
    if (!dateMap[dateStr]) {
      dateMap[dateStr] = { pageviews: 0, visitors: new Set() };
    }
    dateMap[dateStr].pageviews++;
    dateMap[dateStr].visitors.add(ev.anonymousVisitorId);
  }

  // Top pages formatted
  const topPages = Object.entries(pageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pageUrl, views]) => ({
      pageUrl,
      views,
      percentage: totalPageviews > 0 ? Math.round((views / totalPageviews) * 1000) / 10 : 0,
    }));

  // Top referrers formatted
  const topReferrers = Object.entries(referrerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([referrer, count]) => ({ referrer, count }));

  // Trend list
  const trend = Object.entries(dateMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({
      date,
      pageviews: data.pageviews,
      visitors: data.visitors.size,
    }));

  return {
    totalPageviews,
    uniqueVisitors: visitorsSet.size,
    uniqueSessions: sessionsSet.size,
    topPages,
    topReferrers,
    deviceBreakdown,
    trend,
  };
}
