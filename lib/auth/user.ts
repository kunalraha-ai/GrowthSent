import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb.js";
import { UserDocument } from "../db/types.js";

export async function createUser(email: string, passwordPlain: string, name?: string): Promise<UserDocument> {
  const { db } = await connectToDatabase();
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.collection<UserDocument>("users").findOne({ email: normalizedEmail });
  if (existing) {
    throw new Error("An account with this email address already exists.");
  }

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

  const res = await db.collection("users").insertOne(userDoc);
  userDoc._id = res.insertedId;
  return userDoc;
}

export async function verifyUserCredentials(email: string, passwordPlain: string): Promise<UserDocument | null> {
  const { db } = await connectToDatabase();
  const normalizedEmail = email.toLowerCase().trim();

  const user = await db.collection<UserDocument>("users").findOne({ email: normalizedEmail });
  if (!user || !user.passwordHash) return null;

  const match = await bcrypt.compare(passwordPlain, user.passwordHash);
  if (!match) return null;

  return user;
}

export async function getUserById(userId: string): Promise<UserDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<UserDocument>("users").findOne({ _id: new ObjectId(userId) });
  } catch {
    return null;
  }
}

export async function deleteUserAccount(userId: string): Promise<boolean> {
  const { db } = await connectToDatabase();
  const objId = new ObjectId(userId);

  // Delete user document, sessions, websites, scans, analytics
  await db.collection("users").deleteOne({ _id: objId });
  await db.collection("sessions").deleteMany({ userId: objId });
  await db.collection("websites").deleteMany({ userId: objId });
  await db.collection("integrations").deleteMany({ userId: objId });

  return true;
}
