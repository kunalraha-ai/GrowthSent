import { connectToDatabase } from "../db/mongodb";

export async function applyAnalyticsRetentionPolicy(retentionDays: number = 90): Promise<number> {
  const { db } = await connectToDatabase();
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);

  const res = await db.collection("analyticsEvents").deleteMany({
    timestamp: { $lt: cutoffDate },
  });

  return res.deletedCount || 0;
}
