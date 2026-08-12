import bcrypt from "bcryptjs";
import type { ObjectId } from "bson";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { UserDocument } from "../db/types.js";
import { deleteScansAndChildrenInTransaction, deleteWebsiteDataInTransaction } from "../websites/service.js";

export async function createUser(email: string, passwordPlain: string, name?: string): Promise<UserDocument> {
  const { db } = await connectToDatabase();
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.collection<UserDocument>("users").findOne({ email: normalizedEmail });
  if (existing) throw new Error("An account with this email address already exists.");

  const passwordHash = await bcrypt.hash(passwordPlain, 10);
  const now = new Date();
  const userDoc: UserDocument = {
    email: normalizedEmail,
    passwordHash,
    name: name?.trim(),
    role: "user",
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await db.collection<UserDocument>("users").insertOne(userDoc);
    return { ...userDoc, _id: res.insertedId };
  } catch (error: unknown) {
    // A manually-audited unique email index makes concurrent sign-ups safe.
    // Do not reveal Mongo details to the API layer.
    if ((error as { code?: number })?.code === 11000) {
      throw new Error("An account with this email address already exists.");
    }
    throw error;
  }
}

export async function verifyUserCredentials(email: string, passwordPlain: string): Promise<UserDocument | null> {
  const { db } = await connectToDatabase();
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.collection<UserDocument>("users").findOne({ email: normalizedEmail });
  if (!user?.passwordHash) return null;
  return (await bcrypt.compare(passwordPlain, user.passwordHash)) ? user : null;
}

export async function getUserById(userId: string): Promise<UserDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<UserDocument>("users").findOne({ _id: safeObjectId(userId) });
  } catch {
    return null;
  }
}

/**
 * Deletes a user only after every active legacy dependent record is removed in
 * the same transaction. We intentionally do not fall back to non-transactional
 * deletes: an unsupported MongoDB deployment must fail safely instead of
 * leaving an irrecoverably partial account deletion.
 */
export async function deleteUserAccount(userId: string): Promise<boolean> {
  let objId: ObjectId;
  try {
    objId = safeObjectId(userId);
  } catch {
    return false;
  }

  const { client, db } = await connectToDatabase();
  const session = client.startSession();
  let deleted = false;
  try {
    await session.withTransaction(async () => {
      const user = await db.collection<UserDocument>("users").findOne(
        { _id: objId },
        { session, projection: { _id: 1 } }
      );
      if (!user) return;

      // Delete in bounded batches rather than mutating the collection behind a
      // live cursor, which could skip a later batch on some deployments.
      while (true) {
        const websites = await db
          .collection("websites")
          .find({ userId: objId }, { session, projection: { _id: 1 } })
          .limit(250)
          .toArray();
        if (websites.length === 0) break;
        for (const website of websites) {
          if (website._id) {
            await deleteWebsiteDataInTransaction(db, safeObjectId(website._id), objId, session);
          }
        }
      }

      // Saved-site data was removed above. These filters cover authenticated
      // scans/audits not linked to a saved site and legacy records that used the
      // former `clerkUserId` string field for the Mongo user identifier.
      await deleteScansAndChildrenInTransaction(
        db,
        { $or: [{ ownerUserId: objId }, { clerkUserId: userId }] },
        session
      );
      await db.collection("crawlJobs").deleteMany({ clerkUserId: userId }, { session });
      await db.collection("crawlSnapshots").deleteMany({ clerkUserId: userId }, { session });
      await db.collection("integrations").deleteMany({ userId: objId }, { session });
      await db.collection("notifications").deleteMany({ userId: objId }, { session });
      await db.collection("apiKeys").deleteMany({ userId: objId }, { session });
      await db.collection("googleOAuthStates").deleteMany({ userId: objId }, { session });
      await db.collection("sessions").deleteMany({ userId: objId }, { session });

      const result = await db.collection<UserDocument>("users").deleteOne({ _id: objId }, { session });
      if (result.deletedCount !== 1) throw new Error("Account deletion lost user consistency.");
      deleted = true;
    });
    return deleted;
  } finally {
    await session.endSession();
  }
}
