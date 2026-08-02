import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb";
import { IntegrationDocument, WebsiteDocument } from "../db/types";

export type GoogleProvider = "google_search_console" | "google_analytics";

export interface GoogleSearchConsoleData {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GoogleOAuthState {
  _id?: ObjectId;
  state: string;
  userId: ObjectId;
  websiteId: ObjectId;
  provider: GoogleProvider;
  expiresAt: Date;
  createdAt: Date;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ENCRYPTION_KEY must be configured with at least 32 characters before storing OAuth tokens.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(plainToken: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainToken, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptToken(encryptedString: string): string {
  const [ivValue, tagValue, encryptedValue] = encryptedString.split(":");
  if (!ivValue || !tagValue || !encryptedValue) {
    throw new Error("Stored OAuth token has an invalid format.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function providerScopes(provider: GoogleProvider): string[] {
  return provider === "google_search_console"
    ? [
        "openid",
        "email",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ]
    : [
        "openid",
        "email",
        "https://www.googleapis.com/auth/analytics.readonly",
      ];
}

export async function createGoogleAuthorizationUrl(
  userId: string,
  websiteId: string,
  provider: GoogleProvider
): Promise<string> {
  const { clientId, redirectUri } = getGoogleConfig();
  const userObjectId = safeObjectId(userId);
  const websiteObjectId = safeObjectId(websiteId);
  const { db } = await connectToDatabase();
  const state = crypto.randomBytes(32).toString("base64url");

  await db.collection<GoogleOAuthState>("googleOAuthStates").deleteMany({
    expiresAt: { $lt: new Date() },
  });
  await db.collection<GoogleOAuthState>("googleOAuthStates").insertOne({
    state,
    userId: userObjectId,
    websiteId: websiteObjectId,
    provider,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: providerScopes(provider).join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
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
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "Google did not return an access token.");
  }
  return payload;
}

async function lookupGoogleAccountEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { email?: string };
  return payload.email;
}

export async function completeGoogleAuthorization(code: string, state: string): Promise<{
  provider: GoogleProvider;
  websiteId: string;
}> {
  const { db } = await connectToDatabase();
  const storedState = await db.collection<GoogleOAuthState>("googleOAuthStates").findOne({
    state,
    expiresAt: { $gt: new Date() },
  });
  if (!storedState) {
    throw new Error("The Google OAuth request is invalid or has expired. Please try connecting again.");
  }
  await db.collection<GoogleOAuthState>("googleOAuthStates").deleteOne({ _id: storedState._id });

  const tokens = await exchangeGoogleCode(code);
  const accountEmail = await lookupGoogleAccountEmail(tokens.access_token!);
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;

  await saveGoogleIntegration({
    userId: storedState.userId,
    websiteId: storedState.websiteId,
    provider: storedState.provider,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token,
    accountEmail,
    expiresAt,
  });

  return { provider: storedState.provider, websiteId: storedState.websiteId.toString() };
}

export async function saveGoogleIntegration(input: {
  userId: ObjectId;
  websiteId: ObjectId;
  provider: GoogleProvider;
  accessToken: string;
  refreshToken?: string;
  accountEmail?: string;
  expiresAt?: Date;
}): Promise<void> {
  const { db } = await connectToDatabase();
  const now = new Date();
  const update: Partial<IntegrationDocument> = {
    userId: input.userId,
    websiteId: input.websiteId,
    provider: input.provider,
    accessTokenEncrypted: encryptToken(input.accessToken),
    scopes: providerScopes(input.provider),
    status: "active",
    accountEmail: input.accountEmail,
    tokenExpiresAt: input.expiresAt,
    updatedAt: now,
  };
  if (input.refreshToken) update.refreshTokenEncrypted = encryptToken(input.refreshToken);

  await db.collection<IntegrationDocument>("integrations").updateOne(
    { userId: input.userId, websiteId: input.websiteId, provider: input.provider },
    { $set: update, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

export async function getGoogleIntegrationStatus(
  userId: string,
  websiteId: string,
  provider: GoogleProvider
) {
  const { db } = await connectToDatabase();
  const integration = await db.collection<IntegrationDocument>("integrations").findOne({
    userId: safeObjectId(userId),
    websiteId: safeObjectId(websiteId),
    provider,
  });

  return {
    isConnected: integration?.status === "active",
    provider,
    accountEmail: integration?.accountEmail || null,
    lastSyncedAt: integration?.updatedAt || null,
    ga4PropertyId: integration?.ga4PropertyId || null,
    ga4PropertyDisplayName: integration?.ga4PropertyDisplayName || null,
  };
}

export async function disconnectGoogleIntegration(
  userId: string,
  websiteId: string,
  provider: GoogleProvider
): Promise<boolean> {
  const { db } = await connectToDatabase();
  const result = await db.collection<IntegrationDocument>("integrations").deleteOne({
    userId: safeObjectId(userId),
    websiteId: safeObjectId(websiteId),
    provider,
  });
  return result.deletedCount === 1;
}

async function getWebsiteForUser(userId: string, websiteId: string): Promise<WebsiteDocument> {
  const { db } = await connectToDatabase();
  const website = await db.collection<WebsiteDocument>("websites").findOne({
    _id: safeObjectId(websiteId),
    userId: safeObjectId(userId),
  });
  if (!website) throw new Error("Website not found or access denied.");
  return website;
}

async function getActiveIntegration(
  userId: string,
  websiteId: string,
  provider: GoogleProvider
): Promise<IntegrationDocument> {
  const { db } = await connectToDatabase();
  const integration = await db.collection<IntegrationDocument>("integrations").findOne({
    userId: safeObjectId(userId),
    websiteId: safeObjectId(websiteId),
    provider,
    status: "active",
  });
  if (!integration) {
    throw new Error(
      provider === "google_analytics"
        ? "Google Analytics is not connected for this website."
        : "Google Search Console is not connected for this website."
    );
  }
  return integration;
}

/**
 * Google access tokens expire roughly every hour. This returns a valid access token,
 * transparently refreshing it (and persisting the new token) via the stored refresh
 * token when the current one is expired or about to expire.
 */
async function getValidAccessToken(integration: IntegrationDocument): Promise<string> {
  const isExpiringSoon =
    !integration.tokenExpiresAt || integration.tokenExpiresAt.getTime() < Date.now() + 60_000;

  if (!isExpiringSoon) {
    return decryptToken(integration.accessTokenEncrypted);
  }

  if (!integration.refreshTokenEncrypted) {
    throw new Error(
      "Google authorization has expired and no refresh token is available. Please reconnect this integration."
    );
  }

  const { clientId, clientSecret } = getGoogleConfig();
  const refreshToken = decryptToken(integration.refreshTokenEncrypted);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) {
    const { db } = await connectToDatabase();
    await db
      .collection<IntegrationDocument>("integrations")
      .updateOne({ _id: integration._id }, { $set: { status: "error", updatedAt: new Date() } });
    throw new Error(
      payload.error_description || payload.error || "Unable to refresh Google authorization. Please reconnect this integration."
    );
  }

  const newExpiresAt = payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : undefined;
  const { db } = await connectToDatabase();
  await db.collection<IntegrationDocument>("integrations").updateOne(
    { _id: integration._id },
    {
      $set: {
        accessTokenEncrypted: encryptToken(payload.access_token),
        tokenExpiresAt: newExpiresAt,
        status: "active",
        updatedAt: new Date(),
      },
    }
  );
  return payload.access_token;
}

async function getSearchConsoleSite(accessToken: string, hostname: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Google Search Console authorization has expired. Reconnect the integration.");
  const payload = (await response.json()) as { siteEntry?: Array<{ siteUrl: string }> };
  const preferredDomainProperty = `sc-domain:${hostname}`;
  const site = payload.siteEntry?.find((entry) => entry.siteUrl === preferredDomainProperty)
    ?? payload.siteEntry?.find((entry) => {
      try {
        return new URL(entry.siteUrl).hostname === hostname;
      } catch {
        return false;
      }
    });
  if (!site) throw new Error(`No Google Search Console property is available for ${hostname}.`);
  return site.siteUrl;
}

export async function fetchSearchConsoleKeywords(
  userId: string,
  websiteId: string
): Promise<GoogleSearchConsoleData[]> {
  const { db } = await connectToDatabase();
  const website = await getWebsiteForUser(userId, websiteId);
  const integration = await getActiveIntegration(userId, websiteId, "google_search_console");

  const accessToken = await getValidAccessToken(integration);
  const siteUrl = await getSearchConsoleSite(accessToken, website.hostname);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 28 * 24 * 60 * 60 * 1000);
  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        dimensions: ["query"],
        rowLimit: 100,
      }),
    }
  );
  const payload = (await response.json()) as {
    rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || "Unable to load Google Search Console data.");

  await db.collection<IntegrationDocument>("integrations").updateOne(
    { _id: integration._id },
    { $set: { updatedAt: new Date() } }
  );
  return (payload.rows || []).map((row) => ({
    query: row.keys[0] || "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

// ----------------------------------------------------
// GOOGLE ANALYTICS 4 (GA4)
// ----------------------------------------------------

export interface GoogleAnalyticsProperty {
  propertyId: string;
  displayName: string;
  accountName: string;
}

/**
 * Lists every GA4 property the connected Google account can access, via the
 * Analytics Admin API. A Google account may have several properties across
 * multiple accounts, so the user picks the right one for this website.
 */
export async function listGoogleAnalyticsProperties(
  userId: string,
  websiteId: string
): Promise<GoogleAnalyticsProperty[]> {
  const integration = await getActiveIntegration(userId, websiteId, "google_analytics");
  const accessToken = await getValidAccessToken(integration);

  const response = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as {
    accountSummaries?: Array<{
      account: string;
      displayName: string;
      propertySummaries?: Array<{ property: string; displayName: string }>;
    }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || "Unable to load Google Analytics properties.");

  const properties: GoogleAnalyticsProperty[] = [];
  for (const account of payload.accountSummaries || []) {
    for (const prop of account.propertySummaries || []) {
      properties.push({
        propertyId: prop.property.replace("properties/", ""),
        displayName: prop.displayName,
        accountName: account.displayName,
      });
    }
  }
  return properties;
}

/** Stores which GA4 property (of possibly several) the user selected for this website. */
export async function setGoogleAnalyticsProperty(
  userId: string,
  websiteId: string,
  propertyId: string,
  displayName?: string
): Promise<void> {
  const { db } = await connectToDatabase();
  const result = await db.collection<IntegrationDocument>("integrations").updateOne(
    { userId: safeObjectId(userId), websiteId: safeObjectId(websiteId), provider: "google_analytics", status: "active" },
    { $set: { ga4PropertyId: propertyId, ga4PropertyDisplayName: displayName, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw new Error("Google Analytics is not connected for this website.");
}

export interface GoogleAnalyticsReport {
  propertyId: string;
  propertyDisplayName?: string;
  totals: {
    activeUsers: number;
    sessions: number;
    screenPageViews: number;
    bounceRate: number;
    avgSessionDurationSec: number;
  };
  trend: Array<{ date: string; activeUsers: number; sessions: number; screenPageViews: number }>;
  topPages: Array<{ pagePath: string; screenPageViews: number }>;
  topChannels: Array<{ channel: string; sessions: number }>;
}

async function runGa4Report(accessToken: string, propertyId: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Google Analytics reporting request failed.");
  return payload;
}

/** Pulls a real GA4 report (totals, daily trend, top pages, top channels) for the connected property. */
export async function fetchGoogleAnalyticsReport(
  userId: string,
  websiteId: string,
  days: number = 30
): Promise<GoogleAnalyticsReport> {
  const integration = await getActiveIntegration(userId, websiteId, "google_analytics");
  if (!integration.ga4PropertyId) {
    throw new Error("No Google Analytics property has been selected for this website yet.");
  }
  const accessToken = await getValidAccessToken(integration);
  const propertyId = integration.ga4PropertyId;
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  const [totalsPayload, trendPayload, pagesPayload, channelsPayload] = await Promise.all([
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "bounceRate" },
        { name: "averageSessionDuration" },
      ],
    }),
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "date" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    }),
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    }),
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    }),
  ]);

  const totalsRow = totalsPayload.rows?.[0]?.metricValues;
  const totals = {
    activeUsers: Number(totalsRow?.[0]?.value || 0),
    sessions: Number(totalsRow?.[1]?.value || 0),
    screenPageViews: Number(totalsRow?.[2]?.value || 0),
    bounceRate: Number(totalsRow?.[3]?.value || 0),
    avgSessionDurationSec: Number(totalsRow?.[4]?.value || 0),
  };

  const trend = (trendPayload.rows || []).map((row: any) => ({
    date: row.dimensionValues[0].value,
    activeUsers: Number(row.metricValues[0].value),
    sessions: Number(row.metricValues[1].value),
    screenPageViews: Number(row.metricValues[2].value),
  }));

  const topPages = (pagesPayload.rows || []).map((row: any) => ({
    pagePath: row.dimensionValues[0].value,
    screenPageViews: Number(row.metricValues[0].value),
  }));

  const topChannels = (channelsPayload.rows || []).map((row: any) => ({
    channel: row.dimensionValues[0].value,
    sessions: Number(row.metricValues[0].value),
  }));

  const { db } = await connectToDatabase();
  await db.collection<IntegrationDocument>("integrations").updateOne(
    { _id: integration._id },
    { $set: { updatedAt: new Date() } }
  );

  return {
    propertyId,
    propertyDisplayName: integration.ga4PropertyDisplayName,
    totals,
    trend,
    topPages,
    topChannels,
  };
}
