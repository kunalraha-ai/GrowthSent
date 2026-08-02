import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb";
import { SessionDocument, UserDocument } from "../db/types";

export const SESSION_COOKIE_NAME = "gs_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export async function createSession(userId: string): Promise<{ rawToken: string; session: SessionDocument }> {
  const { db } = await connectToDatabase();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const sessionDoc: SessionDocument = {
    userId: new ObjectId(userId),
    tokenHash,
    expiresAt,
    createdAt: new Date(),
  };

  const res = await db.collection("sessions").insertOne(sessionDoc);
  sessionDoc._id = res.insertedId;

  return { rawToken, session: sessionDoc };
}

export async function validateSession(rawToken: string): Promise<UserDocument | null> {
  if (!rawToken) return null;
  const { db } = await connectToDatabase();
  const tokenHash = hashToken(rawToken);

  const session = await db.collection<SessionDocument>("sessions").findOne({
    tokenHash,
    expiresAt: { $gt: new Date() },
  });

  if (!session) return null;

  const user = await db.collection<UserDocument>("users").findOne({ _id: session.userId });
  return user || null;
}

export async function destroySession(rawToken: string): Promise<boolean> {
  if (!rawToken) return false;
  const { db } = await connectToDatabase();
  const tokenHash = hashToken(rawToken);
  await db.collection("sessions").deleteOne({ tokenHash });
  return true;
}

export function buildSessionCookieHeader(rawToken: string, isDelete = false): string {
  const maxAge = isDelete ? 0 : Math.floor(SESSION_DURATION_MS / 1000);
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${SESSION_COOKIE_NAME}=${isDelete ? "" : rawToken}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=${maxAge}`;
}

export function extractSessionTokenFromCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, val] = cookie.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return val || null;
    }
  }
  return null;
}
