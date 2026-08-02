import { ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb";
import { IssueDocument, SeoIssueHistoryDocument } from "../db/types";

export class IssueService {
  static async getIssuesForScan(scanId: string): Promise<IssueDocument[]> {
    const { db } = await connectToDatabase();
    try {
      return await db
        .collection<IssueDocument>("issues")
        .find({ scanId: safeObjectId(scanId) })
        .toArray();
    } catch {
      return [];
    }
  }

  static async getIssueHistoryForWebsite(websiteId: string): Promise<SeoIssueHistoryDocument[]> {
    const { db } = await connectToDatabase();
    try {
      return await db
        .collection<SeoIssueHistoryDocument>("seoIssueHistory")
        .find({ websiteId: safeObjectId(websiteId) })
        .sort({ lastDetectedAt: -1 })
        .toArray();
    } catch {
      return [];
    }
  }

  static async resolveIssue(historyId: string, clerkUserId: string): Promise<boolean> {
    const { db } = await connectToDatabase();
    try {
      const res = await db.collection("seoIssueHistory").updateOne(
        { _id: safeObjectId(historyId) },
        {
          $set: { status: "resolved", resolvedAt: new Date() },
          $push: {
            historyEvents: {
              event: "resolved",
              timestamp: new Date(),
            },
          },
        }
      );
      return res.modifiedCount > 0;
    } catch {
      return false;
    }
  }
}
