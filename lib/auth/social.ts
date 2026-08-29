import crypto from "node:crypto";
import { connectToDatabase } from "../db/mongodb.js";
import { UserDocument } from "../db/types.js";

export type SocialProvider = "google" | "github";

interface LoginOAuthStateDoc {
  state: string;
  provider: SocialProvider;
  browserNonceHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const OAUTH_STATE_BYTES = 32;

function hashBrowserNonce(browserNonce: string): string {
  return crypto.createHash("sha256").update(browserNonce).digest("hex");
}

function isValidBrowserNonce(browserNonce: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(browserNonce);
}

function isValidOAuthState(state: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(state);
}

function getAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:8443").replace(/\/$/, "");
}

function getGoogleLoginConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.GOOGLE_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/google/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("Google sign-in is unavailable.");
  }
  return { clientId, clientSecret, redirectUri };
}

function getGithubLoginConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.GITHUB_LOGIN_REDIRECT_URI?.trim() || `${getAppUrl()}/api/v1/auth/github/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("GitHub sign-in is unavailable.");
  }
  return { clientId, clientSecret, redirectUri };
}

async function createLoginState(provider: SocialProvider, browserNonce: string): Promise<string> {
  if (!isValidBrowserNonce(browserNonce)) {
    throw new Error("Invalid sign-in request.");
  }

  const state = crypto.randomBytes(OAUTH_STATE_BYTES).toString("base64url");
  const { db } = await connectToDatabase();
  await db.collection<LoginOAuthStateDoc>("loginOAuthStates").insertOne({
    state,
    provider,
    browserNonceHash: hashBrowserNonce(browserNonce),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });
  return state;
}

async function consumeLoginState(state: string, provider: SocialProvider, browserNonce: string): Promise<boolean> {
  if (!isValidOAuthState(state) || !isValidBrowserNonce(browserNonce)) return false;

  try {
    const { db } = await connectToDatabase();
    const found = await db.collection<LoginOAuthStateDoc>("loginOAuthStates").findOneAndDelete({
      state,
      provider,
      browserNonceHash: hashBrowserNonce(browserNonce),
      expiresAt: { $gt: new Date() },
    });
    return found !== null;
  } catch {
    return false;
  }
}

async function findOrCreateSocialUser(input: {
  email: string;
  name?: string;
  provider: SocialProvider;
  providerId: string;
  /**
   * Google has asserted that this address is verified.  Allow that assertion
   * to attach the provider identity to an existing GrowthSent account with the
   * same normalized email so its owner can use the direct Google login button.
   */
  allowVerifiedEmailLink?: boolean;
}): Promise<UserDocument> {
  const { db } = await connectToDatabase();
  const normalizedEmail = input.email.toLowerCase().trim();
  const now = new Date();
  const providerField = input.provider === "google" ? "googleId" : "githubId";
  const users = db.collection<UserDocument>("users");

  // A provider subject is the stable identity. It always takes precedence over
  // an email match when resolving an existing social identity.
  const existingProviderUser = await users.findOne({ [providerField]: input.providerId });
  if (existingProviderUser) {
    return existingProviderUser;
  }

  const existingEmailUser = await users.findOne({ email: normalizedEmail });
  if (existingEmailUser) {
    if (input.allowVerifiedEmailLink) {
      try {
        // Do not replace an identity that is already bound to a different
        // provider subject.  The conditional update also makes concurrent
        // first-time callbacks converge on one account safely.
        const linkedUser = await users.findOneAndUpdate(
          {
            _id: existingEmailUser._id,
            [providerField]: { $exists: false },
          },
          {
            $set: {
              [providerField]: input.providerId,
              updatedAt: now,
            },
          },
          { returnDocument: "after" }
        );
        if (linkedUser) return linkedUser;

        // A concurrent callback may have completed the link first.  Return
        // that account only when it is bound to this exact provider subject.
        const concurrentlyLinked = await users.findOne({ [providerField]: input.providerId });
        if (concurrentlyLinked) return concurrentlyLinked;
      } catch (error: unknown) {
        // A sparse unique provider-ID index can report a duplicate during a
        // concurrent first link.  Re-read the identity rather than attaching
        // it to an unrelated account.
        if (typeof error === "object" && error && "code" in error && (error as { code?: unknown }).code === 11000) {
          const concurrentlyLinked = await users.findOne({ [providerField]: input.providerId });
          if (concurrentlyLinked) return concurrentlyLinked;
        }
        throw error;
      }
    }
    throw new Error("An account with this email already exists. Sign in using its existing method.");
  }

  const userDoc: UserDocument = {
    email: normalizedEmail,
    name: input.name,
    role: "user",
    createdAt: now,
    updatedAt: now,
    [providerField]: input.providerId,
  } as UserDocument;

  try {
    const res = await users.insertOne(userDoc);
    userDoc._id = res.insertedId;
    return userDoc;
  } catch (error: any) {
    // A concurrent callback for the same provider identity is safe to treat as
    // the already-created account when a provider-ID unique index is present.
    if (error?.code === 11000) {
      const concurrentlyCreated = await users.findOne({ [providerField]: input.providerId });
      if (concurrentlyCreated) return concurrentlyCreated;
    }
    throw error;
  }
}

export async function createGoogleLoginUrl(browserNonce: string): Promise<string> {
  const { clientId, redirectUri } = getGoogleLoginConfig();
  const state = await createLoginState("google", browserNonce);
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

export async function createGithubLoginUrl(browserNonce: string): Promise<string> {
  const { clientId, redirectUri } = getGithubLoginConfig();
  const state = await createLoginState("github", browserNonce);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function completeGoogleLogin(code: string, state: string, browserNonce: string): Promise<UserDocument> {
  const valid = await consumeLoginState(state, "google", browserNonce);
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
  const tokenPayload = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !tokenPayload.access_token) {
    console.warn("[Google OAuth] Token exchange failed.", { status: tokenRes.status });
    throw new Error("Unable to complete Google sign-in. Please try again.");
  }

  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  if (!profileRes.ok) throw new Error("Unable to fetch your Google account profile.");
  const profile = (await profileRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new Error("Google did not provide a verified email address for this account.");
  }

  return findOrCreateSocialUser({
    email: profile.email,
    name: profile.name,
    provider: "google",
    providerId: profile.sub,
    allowVerifiedEmailLink: true,
  });
}

export async function completeGithubLogin(code: string, state: string, browserNonce: string): Promise<UserDocument> {
  const valid = await consumeLoginState(state, "github", browserNonce);
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
  const tokenPayload = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !tokenPayload.access_token) {
    console.warn("[GitHub OAuth] Token exchange failed.", { status: tokenRes.status });
    throw new Error("Unable to complete GitHub sign-in. Please try again.");
  }

  const profileRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!profileRes.ok) throw new Error("Unable to fetch your GitHub account profile.");
  const profile = (await profileRes.json()) as { id?: number; login?: string; name?: string };

  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!emailsRes.ok) {
    throw new Error("GitHub did not provide a verified email address for this account.");
  }
  const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const preferred = emails.find((email) => email.primary && email.verified) || emails.find((email) => email.verified);
  const email = preferred?.email;

  if (!profile.id || !email) {
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
