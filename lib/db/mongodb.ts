import * as mongodbDriver from "mongodb";
import type { Db, MongoClient as MongoClientType, ObjectId } from "mongodb";

const MongoClient = mongodbDriver.MongoClient;

let cachedClient: MongoClientType | null = null;
let cachedDb: Db | null = null;
let connecting: Promise<{ client: MongoClientType; db: Db }> | null = null;

/**
 * Opens the application's configured MongoDB database.
 *
 * Persistence is a requirement for accounts, scans, sessions and OAuth tokens,
 * so this intentionally fails loudly instead of silently serving a per-process
 * in-memory database. Set MONGODB_URI and MONGODB_DB_NAME in the deployment
 * environment before accepting traffic.
 */
export async function connectToDatabase(): Promise<{ client: MongoClientType; db: Db }> {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (connecting) {
    return connecting;
  }

  const uri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim() || "GrowthSent";

  if (!uri) {
    throw new Error("Database is not configured. Set MONGODB_URI in Vercel project settings.");
  }

  connecting = (async () => {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
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
      throw new Error(`Unable to connect to MongoDB: ${message}`);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** Converts an API identifier to an ObjectId without inventing a replacement. */
export function safeObjectId(id: string | ObjectId): ObjectId {
  if (id instanceof mongodbDriver.ObjectId) return id;
  if (!mongodbDriver.ObjectId.isValid(id) || id.length !== 24 || !/^[a-fA-F0-9]{24}$/.test(id)) {
    throw new Error("Invalid database identifier.");
  }
  return new mongodbDriver.ObjectId(id);
}
