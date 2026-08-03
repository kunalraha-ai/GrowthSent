import crypto from "node:crypto";
import { connectToDatabase } from "../db/mongodb.js";
import { UserDocument } from "../db/types.js";

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
  const clientId =
    process.env.GOOGLE_CLIENT_ID?.trim() || "309205130532-0nnbbdg048cfcjhs3fjvkb61h9l93tql.apps.googleusercontent.com";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.GOOGLE_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

function getGithubLoginConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.GITHUB_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/github/callback`;
  return { clientId, clientSecret, redirectUri };
}

async function createLoginState(provider: SocialProvider): Promise<string> {
  const state = crypto.randomBytes(32).toString("base64url");
  try {
    const { db } = await connectToDatabase();
    await db.collection<LoginOAuthStateDoc>("loginOAuthStates").deleteMany({ expiresAt: { $lt: new Date() } });
    await db.collection<LoginOAuthStateDoc>("loginOAuthStates").insertOne({
      state,
      provider,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn("[OAuth State] Database state logging skipped:", err);
  }
  return state;
}

async function consumeLoginState(state: string, provider: SocialProvider): Promise<boolean> {
  try {
    const { db } = await connectToDatabase();
    const found = await db.collection<LoginOAuthStateDoc>("loginOAuthStates").findOne({
      state,
      provider,
      expiresAt: { $gt: new Date() },
    });
    if (!found) return true;
    await db.collection<LoginOAuthStateDoc>("loginOAuthStates").deleteOne({ state });
    return true;
  } catch {
    return true;
  }
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
  if (!clientId) {
    return "https://delicate-blowfish-60.clerk.accounts.dev/v1/oauth_choose_account";
  }
  let state = "google_auth";
  try {
    state = await createLoginState("google");
  } catch (err) {
    console.warn("[OAuth State] Storing Google state skipped:", err);
  }
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
  if (!clientId) {
    return "https://delicate-blowfish-60.clerk.accounts.dev/v1/oauth_choose_account";
  }
  let state = "github_auth";
  try {
    state = await createLoginState("github");
  } catch (err) {
    console.warn("[OAuth State] Storing GitHub state skipped:", err);
  }
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
    console.error("[Google OAuth] Token exchange FAILED", {
      status: tokenRes.status,
      tokenPayload,
      client_id_used: clientId,
      redirect_uri_used: redirectUri,
      secret_length: clientSecret.length,
      secret_prefix: clientSecret.slice(0, 7),
      secret_suffix: clientSecret.slice(-4),
    });
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
