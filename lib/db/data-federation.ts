import { Db, MongoClient } from "mongodb";

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;
let connecting: Promise<{ client: MongoClient; db: Db }> | null = null;

/**
 * Opens the read-only Atlas Data Federation database used for Common Crawl
 * analytics. This is deliberately separate from the application's operational
 * Atlas database connection in mongodb.ts.
 */
export async function connectToDataFederation(): Promise<{ client: MongoClient; db: Db }> {
  if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
  if (connecting) return connecting;

  const uri = process.env.MONGODB_DATA_FEDERATION_URI?.trim();
  const dbName = process.env.MONGODB_DATA_FEDERATION_DB_NAME?.trim();
  if (!uri || !dbName) {
    throw new Error("Common Crawl analytics is not configured.");
  }

  connecting = (async () => {
    const client = new MongoClient(uri, {
      appName: "growthsent-backlink-analytics",
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      socketTimeoutMS: 12_000,
    });

    try {
      await client.connect();
      const db = client.db(dbName);
      await db.command({ ping: 1 });
      cachedClient = client;
      cachedDb = db;
      return { client, db };
    } catch (error) {
      await client.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown connection error";
      throw new Error(`Unable to connect to Common Crawl analytics: ${message}`);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}
