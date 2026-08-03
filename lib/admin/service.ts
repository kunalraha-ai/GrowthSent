import { connectToDatabase } from "../db/mongodb.js";

export interface AdminStatsSummary {
  totalUsers: number;
  totalWebsites: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
}

export async function getAdminStats(): Promise<AdminStatsSummary> {
  const { db } = await connectToDatabase();

  const totalUsers = await db.collection("users").countDocuments();
  const totalWebsites = await db.collection("websites").countDocuments();
  const totalScans = await db.collection("scans").countDocuments();
  const completedScans = await db.collection("scans").countDocuments({ status: "completed" });
  const failedScans = await db.collection("scans").countDocuments({ status: "failed" });

  return {
    totalUsers,
    totalWebsites,
    totalScans,
    completedScans,
    failedScans,
  };
}
