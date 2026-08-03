import { connectToDatabase } from "./mongodb.js";

export async function initializeDatabaseIndexes() {
  const { db } = await connectToDatabase();
  if (!db || typeof db.collection !== "function") return;

  try {
    // users
    await db.collection("users").createIndex({ email: 1 }, { unique: true });

    // sessions
    await db.collection("sessions").createIndex({ tokenHash: 1 });
    await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // websites
    await db.collection("websites").createIndex({ userId: 1, hostname: 1 });

    // scans
    await db.collection("scans").createIndex({ websiteId: 1, createdAt: -1 });
    await db.collection("scans").createIndex({ anonymousSessionId: 1 });

    // pages
    await db.collection("pages").createIndex({ scanId: 1, normalizedUrl: 1 });

    // issues
    await db.collection("issues").createIndex({ scanId: 1, severity: 1, ruleId: 1 });

    // monitoringSnapshots
    await db.collection("monitoringSnapshots").createIndex({ websiteId: 1, createdAt: -1 });

    // analyticsEvents
    await db.collection("analyticsEvents").createIndex({ websiteId: 1, timestamp: -1 });
    // Expire raw analytics events after 90 days
    await db.collection("analyticsEvents").createIndex({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

    // analyticsAggregates
    await db.collection("analyticsAggregates").createIndex({ websiteId: 1, date: 1 }, { unique: true });

    // integrations
    await db.collection("integrations").createIndex({ userId: 1, websiteId: 1, provider: 1 });

    // apiKeys
    await db.collection("apiKeys").createIndex({ keyHash: 1 }, { unique: true });
  } catch (err) {
    console.warn("Database index initialization warning:", err);
  }
}
