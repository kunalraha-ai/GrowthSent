import crypto from "node:crypto";
import { connectToDatabase } from "../db/mongodb";
import { UserDocument } from "../db/types";

export type SocialProvider = "google" | "github";

interface LoginOAuthStateDoc {
  state: string;
  provider: SocialProvider;
  expiresAt: Date;
  createdAt: Date;
}

function getAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:8443").replace(/\/$/, "");
}

function getGoogleLoginConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  const redirectUri =
    process.env.GOOGLE_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

function getGithubLoginConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("GitHub sign-in is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  }
  const redirectUri =
    process.env.GITHUB_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/github/callback`;
  return { clientId, clientSecret, redirectUri };
}

async function createLoginState(provider: SocialProvider): Promise<string> {
  const { db } = await connectToDatabase();
  const state = crypto.randomBytes(32).toString("base64url");
  await db.collection<LoginOAuthStateDoc>("loginOAuthStates").deleteMany({ expiresAt: { $lt: new Date() } });
  await db.collection<LoginOAuthStateDoc>("loginOAuthStates").insertOne({
    state,
    provider,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });
  return state;
}

async function consumeLoginState(state: string, provider: SocialProvider): Promise<boolean> {
  const { db } = await connectToDatabase();
  const found = await db.collection<LoginOAuthStateDoc>("loginOAuthStates").findOne({
    state,
    provider,
    expiresAt: { $gt: new Date() },
  });
  if (!found) return false;
  await db.collection<LoginOAuthStateDoc>("loginOAuthStates").deleteOne({ state });
  return true;
}

async function findOrCreateSocialUser(input: {
  email: string;
  name?: string;
  provider: SocialProvider;
  providerId: string;
}): Promise<UserDocument> {
  const { db } = await connectToDatabase();
  const normalizedEmail = input.email.toLowerCase().trim();
  const now = new Date();
  const providerField = input.provider === "google" ? "googleId" : "githubId";

  const existing = await db.collection<UserDocument>("users").findOne({ email: normalizedEmail });
  if (existing) {
    await db
      .collection<UserDocument>("users")
      .updateOne({ _id: existing._id }, { $set: { [providerField]: input.providerId, updatedAt: now } });
    return existing;
  }

  const userDoc: UserDocument = {
    email: normalizedEmail,
    name: input.name,
    role: "user",
    createdAt: now,
    updatedAt: now,
    [providerField]: input.providerId,
  } as UserDocument;

  const res = await db.collection("users").insertOne(userDoc);
  userDoc._id = res.insertedId;
  return userDoc;
}

export async function createGoogleLoginUrl(): Promise<string> {
  const { clientId, redirectUri } = getGoogleLoginConfig();
  const state = await createLoginState("google");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function createGithubLoginUrl(): Promise<string> {
  const { clientId, redirectUri } = getGithubLoginConfig();
  const state = await createLoginState("github");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function completeGoogleLogin(code: string, state: string): Promise<UserDocument> {
  const valid = await consumeLoginState(state, "google");
  if (!valid) throw new Error("The Google sign-in request is invalid or has expired. Please try again.");

  const { clientId, clientSecret, redirectUri } = getGoogleLoginConfig();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenPayload = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !tokenPayload.access_token) {
    throw new Error(tokenPayload.error_description || tokenPayload.error || "Google did not return an access token.");
  }

  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  if (!profileRes.ok) throw new Error("Unable to fetch your Google account profile.");
  const profile = (await profileRes.json()) as { sub: string; email?: string; name?: string };

  if (!profile.email) throw new Error("Google did not provide an email address for this account.");

  return findOrCreateSocialUser({
    email: profile.email,
    name: profile.name,
    provider: "google",
    providerId: profile.sub,
  });
}

export async function completeGithubLogin(code: string, state: string): Promise<UserDocument> {
  const valid = await consumeLoginState(state, "github");
  if (!valid) throw new Error("The GitHub sign-in request is invalid or has expired. Please try again.");

  const { clientId, clientSecret, redirectUri } = getGithubLoginConfig();
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const tokenPayload = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !tokenPayload.access_token) {
    throw new Error(tokenPayload.error_description || tokenPayload.error || "GitHub did not return an access token.");
  }

  const profileRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!profileRes.ok) throw new Error("Unable to fetch your GitHub account profile.");
  const profile = (await profileRes.json()) as { id: number; login: string; name?: string; email?: string };

  let email = profile.email;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const preferred = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      email = preferred?.email;
    }
  }
  if (!email) {
    throw new Error(
      "GitHub did not provide a verified email address for this account. Add a verified email on GitHub and try again."
    );
  }

  return findOrCreateSocialUser({
    email,
    name: profile.name || profile.login,
    provider: "github",
    providerId: String(profile.id),
  });
}
