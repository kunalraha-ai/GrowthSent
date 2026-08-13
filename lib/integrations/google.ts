import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { IntegrationDocument, WebsiteDocument } from "../db/types.js";
import {
  buildSearchIntelligenceReport,
  type GscMetrics,
  type GscPageRow,
  type GscQueryPageRow,
  type GscQueryRow,
  type SearchIntelligenceReport,
} from "./search-intelligence.js";

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
  browserNonceHash: string;
  expiresAt: Date;
  createdAt: Date;
}

function hashBrowserNonce(browserNonce: string): string {
  return crypto.createHash("sha256").update(browserNonce).digest("hex");
}

function isValidBrowserNonce(browserNonce: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(browserNonce);
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
  provider: GoogleProvider,
  browserNonce: string
): Promise<string> {
  if (!isValidBrowserNonce(browserNonce)) {
    throw new Error("Invalid Google OAuth request.");
  }
  const { clientId, redirectUri } = getGoogleConfig();
  const userObjectId = safeObjectId(userId);
  const websiteObjectId = safeObjectId(websiteId);
  const { db } = await connectToDatabase();
  const state = crypto.randomBytes(32).toString("base64url");

  await db.collection<GoogleOAuthState>("googleOAuthStates").insertOne({
    state,
    userId: userObjectId,
    websiteId: websiteObjectId,
    provider,
    browserNonceHash: hashBrowserNonce(browserNonce),
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

export async function completeGoogleAuthorization(code: string, state: string, browserNonce: string): Promise<{
  provider: GoogleProvider;
  websiteId: string;
}> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !isValidBrowserNonce(browserNonce)) {
    throw new Error("The Google OAuth request is invalid or has expired. Please try connecting again.");
  }

  const { db } = await connectToDatabase();
  const storedState = await db.collection<GoogleOAuthState>("googleOAuthStates").findOneAndDelete({
    state,
    browserNonceHash: hashBrowserNonce(browserNonce),
    expiresAt: { $gt: new Date() },
  });
  if (!storedState) {
    throw new Error("The Google OAuth request is invalid or has expired. Please try connecting again.");
  }

  const website = await db.collection<WebsiteDocument>("websites").findOne({
    _id: storedState.websiteId,
    userId: storedState.userId,
  });
  if (!website) {
    throw new Error("The selected website is no longer available. Please try connecting again.");
  }

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
  
  const rawHostname = hostname.toLowerCase().trim();
  const cleanHostname = rawHostname.replace(/^www\./, "");

  const site =
    payload.siteEntry?.find((entry) => entry.siteUrl.toLowerCase() === `sc-domain:${rawHostname}`)
    ?? payload.siteEntry?.find((entry) => entry.siteUrl.toLowerCase() === `sc-domain:${cleanHostname}`)
    ?? payload.siteEntry?.find((entry) => {
      try {
        const entryHost = new URL(entry.siteUrl).hostname.toLowerCase();
        return entryHost === rawHostname || entryHost.replace(/^www\./, "") === cleanHostname;
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

export interface GscFullReportData {
  connected: boolean;
  siteUrl: string;
  lastSynced: string;
  dateRange: {
    startDate: string;
    endDate: string;
    days: number;
  };
  summary: {
    totalClicks: number;
    totalImpressions: number;
    avgCtr: number;
    avgPosition: number;
  };
  dailySeries: Array<{
    date: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  topQueries: Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  topPages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  countries: Array<{
    country: string;
    countryCode: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  devices: Array<{
    device: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  searchAppearance: Array<{
    appearance: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  sitemaps: Array<{
    path: string;
    lastDownloaded: string;
    isPending: boolean;
    isWarnings: boolean;
    hasErrors: boolean;
    type: string;
    submitted: number;
    indexed: number;
  }>;
  opportunities: Array<{
    id: string;
    type: "low_ctr" | "striking_distance" | "zero_clicks" | "top_performing";
    title: string;
    description: string;
    queryOrPage: string;
    metrics: { clicks: number; impressions: number; ctr: number; position: number };
  }>;
  indexingOverview?: {
    indexedPages: number;
    notIndexed: number;
    errors: number;
    excluded: number;
  };
  coverageIssues?: Array<{
    title: string;
    severity: string;
    affectedUrl: string;
    description: string;
  }>;
}

function formatCountryName(code: string): string {
  if (!code) return "Unknown";
  const upper = code.toUpperCase();
  try {
    const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(upper) || upper;
  } catch {
    return upper;
  }
}

const gscReportCache = new Map<string, { data: GscFullReportData; timestamp: number }>();
const ga4ReportCache = new Map<string, { data: Ga4FullReportData; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL
const GSC_INTELLIGENCE_CACHE_TTL_MS = 60 * 1000;
const GSC_INTELLIGENCE_REQUEST_TIMEOUT_MS = 8_000;
const GSC_INTELLIGENCE_QUERY_ROW_LIMIT = 250;
const GSC_INTELLIGENCE_PAGE_ROW_LIMIT = 250;
const GSC_INTELLIGENCE_QUERY_PAGE_ROW_LIMIT = 500;

const gscIntelligenceCache = new Map<string, { data: SearchIntelligenceReport; timestamp: number }>();
const gscIntelligenceInFlight = new Map<string, Promise<SearchIntelligenceReport>>();

interface GscSearchAnalyticsApiRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface GscSearchAnalyticsApiResponse {
  rows?: GscSearchAnalyticsApiRow[];
  error?: { message?: string };
}

interface GscSearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: Array<"date" | "query" | "page">;
  rowLimit: number;
}

function dateRangeForGsc(days: number) {
  const boundedDays = Math.max(7, Math.min(90, Math.floor(days)));
  const currentEnd = new Date();
  // Search Console finalizes data with a short delay. Avoid presenting partial days as final data.
  currentEnd.setUTCDate(currentEnd.getUTCDate() - 2);
  const currentStart = new Date(currentEnd);
  currentStart.setUTCDate(currentStart.getUTCDate() - (boundedDays - 1));
  const previousEnd = new Date(currentStart);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - (boundedDays - 1));

  const format = (date: Date) => date.toISOString().slice(0, 10);
  return {
    current: { startDate: format(currentStart), endDate: format(currentEnd), days: boundedDays },
    previous: { startDate: format(previousStart), endDate: format(previousEnd), days: boundedDays },
  };
}

async function fetchSearchAnalyticsRows(
  apiEndpoint: string,
  accessToken: string,
  request: GscSearchAnalyticsRequest
): Promise<GscSearchAnalyticsApiRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GSC_INTELLIGENCE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as GscSearchAnalyticsApiResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message || "Google Search Console did not return search analytics data.");
    }
    return payload.rows || [];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Google Search Console did not respond before the request safety limit.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toMetrics(row: GscSearchAnalyticsApiRow): GscMetrics {
  return {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0,
  };
}

/**
 * Returns only bounded Search Console observations. Query/page result sets are
 * intentionally capped because Search Console's dimensions are not a complete
 * keyword or URL index. The overview comes from date rows, not those caps.
 */
export async function fetchSearchIntelligenceReport(
  userId: string,
  websiteId: string,
  days = 28
): Promise<SearchIntelligenceReport> {
  const boundedDays = Math.max(7, Math.min(90, Math.floor(days)));
  const cacheKey = `${userId}:${websiteId}:${boundedDays}`;
  const cached = gscIntelligenceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GSC_INTELLIGENCE_CACHE_TTL_MS) {
    return cached.data;
  }

  const inFlight = gscIntelligenceInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    const { db } = await connectToDatabase();
    const website = await getWebsiteForUser(userId, websiteId);
    const integration = await getActiveIntegration(userId, websiteId, "google_search_console");
    const accessToken = await getValidAccessToken(integration);
    const siteUrl = await getSearchConsoleSite(accessToken, website.hostname);
    const ranges = dateRangeForGsc(boundedDays);
    const apiEndpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

    const [
      currentDaily,
      previousDaily,
      currentQueries,
      previousQueries,
      currentPages,
      previousPages,
      currentQueryPages,
    ] = await Promise.all([
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.current, dimensions: ["date"], rowLimit: boundedDays + 2 }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.previous, dimensions: ["date"], rowLimit: boundedDays + 2 }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.current, dimensions: ["query"], rowLimit: GSC_INTELLIGENCE_QUERY_ROW_LIMIT }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.previous, dimensions: ["query"], rowLimit: GSC_INTELLIGENCE_QUERY_ROW_LIMIT }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.current, dimensions: ["page"], rowLimit: GSC_INTELLIGENCE_PAGE_ROW_LIMIT }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.previous, dimensions: ["page"], rowLimit: GSC_INTELLIGENCE_PAGE_ROW_LIMIT }),
      fetchSearchAnalyticsRows(apiEndpoint, accessToken, { ...ranges.current, dimensions: ["query", "page"], rowLimit: GSC_INTELLIGENCE_QUERY_PAGE_ROW_LIMIT }),
    ]);

    const report = buildSearchIntelligenceReport({
      siteUrl,
      currentPeriod: ranges.current,
      previousPeriod: ranges.previous,
      currentDaily: currentDaily.map(toMetrics),
      previousDaily: previousDaily.map(toMetrics),
      currentQueries: currentQueries.map((row): GscQueryRow => ({ query: row.keys?.[0] || "", ...toMetrics(row) })).filter((row) => row.query),
      previousQueries: previousQueries.map((row): GscQueryRow => ({ query: row.keys?.[0] || "", ...toMetrics(row) })).filter((row) => row.query),
      currentPages: currentPages.map((row): GscPageRow => ({ page: row.keys?.[0] || "", ...toMetrics(row) })).filter((row) => row.page),
      previousPages: previousPages.map((row): GscPageRow => ({ page: row.keys?.[0] || "", ...toMetrics(row) })).filter((row) => row.page),
      currentQueryPages: currentQueryPages.map((row): GscQueryPageRow => ({ query: row.keys?.[0] || "", page: row.keys?.[1] || "", ...toMetrics(row) })).filter((row) => row.query && row.page),
      reportedRowLimits: {
        queries: GSC_INTELLIGENCE_QUERY_ROW_LIMIT,
        pages: GSC_INTELLIGENCE_PAGE_ROW_LIMIT,
        queryPageCombinations: GSC_INTELLIGENCE_QUERY_PAGE_ROW_LIMIT,
      },
    });

    await db.collection<IntegrationDocument>("integrations").updateOne(
      { _id: integration._id },
      { $set: { updatedAt: new Date() } }
    );
    gscIntelligenceCache.set(cacheKey, { data: report, timestamp: Date.now() });
    return report;
  })();

  gscIntelligenceInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    gscIntelligenceInFlight.delete(cacheKey);
  }
}

export async function fetchSearchConsoleFullReport(
  userId: string,
  websiteId: string,
  days: number = 28
): Promise<GscFullReportData> {
  const cacheKey = `${userId}:${websiteId}:${days}`;
  const cached = gscReportCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const { db } = await connectToDatabase();
  const website = await getWebsiteForUser(userId, websiteId);
  const integration = await getActiveIntegration(userId, websiteId, "google_search_console");

  const accessToken = await getValidAccessToken(integration);
  const siteUrl = await getSearchConsoleSite(accessToken, website.hostname);

  const endDateObj = new Date();
  endDateObj.setDate(endDateObj.getDate() - 2);
  const startDateObj = new Date(endDateObj.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const startDate = startDateObj.toISOString().slice(0, 10);
  const endDate = endDateObj.toISOString().slice(0, 10);

  const apiEndpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const [
    dailyRes,
    queryRes,
    pageRes,
    countryRes,
    deviceRes,
    appearanceRes,
    sitemapRes,
    latestScanRes,
  ] = await Promise.all([
    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["date"], rowLimit: 1000 }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["query"], rowLimit: 500 }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 500 }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["country"], rowLimit: 100 }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["device"] }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(apiEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate, dimensions: ["searchAppearance"] }),
    }).then((r) => r.json()).catch(() => ({ rows: [] })),

    fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json()).catch(() => ({ sitemap: [] })),

    db.collection("scans").findOne({ websiteId: website._id }, { sort: { createdAt: -1 } }).catch(() => null),
  ]);

  const dailySeries = (dailyRes.rows || []).map((r: any) => ({
    date: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  })).sort((a: any, b: any) => a.date.localeCompare(b.date));

  const topQueries = (queryRes.rows || []).map((r: any) => ({
    query: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));

  const topPages = (pageRes.rows || []).map((r: any) => ({
    page: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));

  const countries = (countryRes.rows || []).map((r: any) => ({
    country: formatCountryName(r.keys[0]),
    countryCode: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));

  const devices = (deviceRes.rows || []).map((r: any) => ({
    device: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));

  const searchAppearance = (appearanceRes.rows || []).map((r: any) => ({
    appearance: r.keys[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));

  const sitemaps = (sitemapRes.sitemap || []).map((s: any) => ({
    path: s.path || "",
    lastDownloaded: s.lastDownloaded || s.lastSubmitted || "",
    isPending: Boolean(s.isPending),
    isWarnings: Boolean(s.warnings > 0),
    hasErrors: Boolean(s.errors > 0),
    type: s.type || "sitemap",
    submitted: s.contents?.[0]?.submitted || 0,
    indexed: s.contents?.[0]?.indexed || 0,
  }));

  const totalClicks = topQueries.reduce((acc: number, q: { clicks: number }) => acc + q.clicks, 0) || dailySeries.reduce((acc: number, d: { clicks: number }) => acc + d.clicks, 0);
  const totalImpressions = topQueries.reduce((acc: number, q: { impressions: number }) => acc + q.impressions, 0) || dailySeries.reduce((acc: number, d: { impressions: number }) => acc + d.impressions, 0);
  const avgCtr = totalImpressions ? totalClicks / totalImpressions : 0;
  const avgPosition = topQueries.length
    ? topQueries.reduce((acc: number, q: { position: number }) => acc + q.position, 0) / topQueries.length
    : (dailySeries.length ? dailySeries.reduce((acc: number, d: { position: number }) => acc + d.position, 0) / dailySeries.length : 0);

  const opportunities: GscFullReportData["opportunities"] = [];

  // Deterministic opportunity logic (NO AI)
  topQueries
    .filter((q: { impressions: number; ctr: number }) => q.impressions >= 40 && q.ctr < 0.025)
    .slice(0, 5)
    .forEach((q: { query: string; impressions: number; ctr: number; clicks: number; position: number }, idx: number) => {
      opportunities.push({
        id: `low_ctr_${idx}`,
        type: "low_ctr",
        title: `Low CTR on "${q.query}" (${q.impressions.toLocaleString()} impressions)`,
        description: `This query gets ${q.impressions.toLocaleString()} search impressions but only a ${(q.ctr * 100).toFixed(1)}% CTR. Update page title and meta description to increase clicks.`,
        queryOrPage: q.query,
        metrics: { clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position },
      });
    });

  topQueries
    .filter((q: { position: number; impressions: number }) => q.position >= 8 && q.position <= 20 && q.impressions >= 15)
    .slice(0, 5)
    .forEach((q: { query: string; impressions: number; ctr: number; clicks: number; position: number }, idx: number) => {
      opportunities.push({
        id: `striking_${idx}`,
        type: "striking_distance",
        title: `Striking Distance: "${q.query}" (Position #${q.position.toFixed(1)})`,
        description: `Currently ranked on Page 2 / bottom Page 1 (Position #${q.position.toFixed(1)}). Optimize headings and internal links to push to top 3.`,
        queryOrPage: q.query,
        metrics: { clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position },
      });
    });

  topQueries
    .filter((q: { impressions: number; clicks: number }) => q.impressions >= 25 && q.clicks === 0)
    .slice(0, 5)
    .forEach((q: { query: string; impressions: number; ctr: number; clicks: number; position: number }, idx: number) => {
      opportunities.push({
        id: `zero_click_${idx}`,
        type: "zero_clicks",
        title: `Zero Clicks for "${q.query}" (${q.impressions} impressions)`,
        description: `Appeared ${q.impressions} times in search results but generated 0 clicks. Review search intent alignment.`,
        queryOrPage: q.query,
        metrics: { clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position },
      });
    });

  topQueries
    .filter((q: { clicks: number; ctr: number }) => q.clicks >= 5 && q.ctr >= 0.05)
    .slice(0, 3)
    .forEach((q: { query: string; impressions: number; ctr: number; clicks: number; position: number }, idx: number) => {
      opportunities.push({
        id: `top_perf_${idx}`,
        type: "top_performing",
        title: `Top Performer: "${q.query}" (${(q.ctr * 100).toFixed(1)}% CTR)`,
        description: `High user engagement (${q.clicks} clicks, ${(q.ctr * 100).toFixed(1)}% CTR). Expand content topics related to this term.`,
        queryOrPage: q.query,
        metrics: { clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position },
      });
    });

  let indexingOverview: GscFullReportData["indexingOverview"] = undefined;
  if (latestScanRes) {
    const pagesCrawled = latestScanRes.crawlStats?.totalPagesCrawled || 0;
    const criticals = latestScanRes.summaryMetrics?.criticalIssues || 0;
    const highs = latestScanRes.summaryMetrics?.highIssues || 0;

    indexingOverview = {
      indexedPages: Math.max(0, pagesCrawled - criticals),
      notIndexed: criticals,
      errors: criticals,
      excluded: highs,
    };
  }

  await db.collection("integrations").updateOne(
    { _id: integration._id },
    { $set: { updatedAt: new Date() } }
  );

  const reportResult: GscFullReportData = {
    connected: true,
    siteUrl,
    lastSynced: new Date().toISOString(),
    dateRange: {
      startDate,
      endDate,
      days,
    },
    summary: {
      totalClicks,
      totalImpressions,
      avgCtr,
      avgPosition,
    },
    dailySeries,
    topQueries,
    topPages,
    countries,
    devices,
    searchAppearance,
    sitemaps,
    opportunities,
    indexingOverview,
  };

  gscReportCache.set(cacheKey, { data: reportResult, timestamp: Date.now() });
  return reportResult;
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

export interface Ga4FullReportData {
  connected: boolean;
  propertyId: string;
  propertyDisplayName?: string;
  lastSynced: string;
  dateRange: {
    days: number;
    startDate: string;
    endDate: string;
  };
  kpis: {
    users: { current: number; previous: number; pctChange: number; series: number[] };
    sessions: { current: number; previous: number; pctChange: number; series: number[] };
    engagedSessions: { current: number; previous: number; pctChange: number; series: number[] };
    engagementRate: { current: number; previous: number; pctChange: number; series: number[] };
    avgEngagementTimeSec: { current: number; previous: number; pctChange: number; series: number[] };
    eventCount: { current: number; previous: number; pctChange: number; series: number[] };
  };
  dailySeries: Array<{
    date: string;
    users: number;
    sessions: number;
    pageViews: number;
    engagedSessions: number;
    eventCount: number;
  }>;
  trafficSources: Array<{
    channel: string;
    users: number;
    sessions: number;
    engagementRate: number;
  }>;
  landingPages: Array<{
    pagePath: string;
    users: number;
    sessions: number;
    bounceRate: number;
    engagementRate: number;
    avgEngagementTimeSec: number;
  }>;
  countries: Array<{
    country: string;
    countryCode?: string;
    users: number;
    sessions: number;
  }>;
  devices: {
    categories: Array<{ device: string; users: number; percentage: number }>;
    browsers: Array<{ browser: string; users: number }>;
    os: Array<{ os: string; users: number }>;
  };
  realtime?: {
    activeUsers: number;
    activePages: Array<{ pagePath: string; activeUsers: number }>;
    activeCountries: Array<{ country: string; activeUsers: number }>;
    activeDevices: Array<{ device: string; activeUsers: number }>;
  };
  events: Array<{
    eventName: string;
    count: number;
    users: number;
  }>;
  conversions: Array<{
    eventName: string;
    count: number;
    rate: number;
  }>;
  audience: {
    newUsers: number;
    returningUsers: number;
    avgSessionDurationSec: number;
    sessionsPerUser: number;
  };
  seoInsights: Array<{
    id: string;
    type: "poor_engagement" | "high_bounce" | "growing_source" | "declining_traffic" | "low_conversion";
    title: string;
    description: string;
    metricLabel: string;
  }>;
}

export async function fetchGa4FullReport(
  userId: string,
  websiteId: string,
  days: number = 28
): Promise<Ga4FullReportData> {
  const cacheKey = `${userId}:${websiteId}:${days}`;
  const cached = ga4ReportCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const integration = await getActiveIntegration(userId, websiteId, "google_analytics");
  if (!integration.ga4PropertyId) {
    throw new Error("No Google Analytics property has been selected for this website yet.");
  }
  const accessToken = await getValidAccessToken(integration);
  const propertyId = integration.ga4PropertyId;

  const currentStartDate = `${days}daysAgo`;
  const currentEndDate = "today";
  const prevStartDate = `${days * 2}daysAgo`;
  const prevEndDate = `${days + 1}daysAgo`;

  const dateRanges = [
    { startDate: currentStartDate, endDate: currentEndDate },
    { startDate: prevStartDate, endDate: prevEndDate },
  ];

  const runGa4Realtime = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runRealtimeReport`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch {
      return { rows: [] };
    }
  };

  const [
    kpisPayload,
    trendPayload,
    sourcesPayload,
    pagesPayload,
    countriesPayload,
    devicesPayload,
    browsersPayload,
    osPayload,
    eventsPayload,
    newVsReturningPayload,
    realtimeUsersPayload,
    realtimePagesPayload,
  ] = await Promise.all([
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
        { name: "userEngagementDuration" },
        { name: "eventCount" },
      ],
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "engagedSessions" },
        { name: "eventCount" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "engagementRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "landingPagePlusQueryString" }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "bounceRate" },
        { name: "engagementRate" },
        { name: "userEngagementDuration" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 15,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "browser" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 5,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "operatingSystem" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 5,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 20,
    }).catch(() => ({ rows: [] })),

    runGa4Report(accessToken, propertyId, {
      dateRanges: [{ startDate: currentStartDate, endDate: currentEndDate }],
      dimensions: [{ name: "newVsReturning" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "averageSessionDuration" }],
    }).catch(() => ({ rows: [] })),

    runGa4Realtime({
      metrics: [{ name: "activeUsers" }],
    }),

    runGa4Realtime({
      dimensions: [{ name: "unifiedScreenName" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 5,
    }),
  ]);

  const currentKpiRow = kpisPayload.rows?.find((r: any) => r.dimensionValues?.[0]?.value === "date_range_0")?.metricValues || kpisPayload.rows?.[0]?.metricValues || [];
  const prevKpiRow = kpisPayload.rows?.find((r: any) => r.dimensionValues?.[0]?.value === "date_range_1")?.metricValues || kpisPayload.rows?.[1]?.metricValues || [];

  const parseKpiMetric = (currIdx: number) => {
    const current = Number(currentKpiRow[currIdx]?.value || 0);
    const previous = Number(prevKpiRow[currIdx]?.value || 0);
    const pctChange = previous ? Math.round(((current - previous) / previous) * 100) : 0;
    return { current, previous, pctChange, series: [] };
  };

  const usersKpi = parseKpiMetric(0);
  const sessionsKpi = parseKpiMetric(1);
  const engagedSessionsKpi = parseKpiMetric(2);
  const engagementRateKpi = parseKpiMetric(3);
  const avgEngagementTimeKpi = parseKpiMetric(4);
  const eventCountKpi = parseKpiMetric(5);

  const dailySeries = (trendPayload.rows || []).map((r: any) => ({
    date: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value || 0),
    sessions: Number(r.metricValues[1].value || 0),
    pageViews: Number(r.metricValues[2].value || 0),
    engagedSessions: Number(r.metricValues[3].value || 0),
    eventCount: Number(r.metricValues[4].value || 0),
  }));

  usersKpi.series = dailySeries.map((d: any) => d.users);
  sessionsKpi.series = dailySeries.map((d: any) => d.sessions);
  engagedSessionsKpi.series = dailySeries.map((d: any) => d.engagedSessions);
  eventCountKpi.series = dailySeries.map((d: any) => d.eventCount);

  const trafficSources = (sourcesPayload.rows || []).map((r: any) => ({
    channel: r.dimensionValues[0].value || "Unassigned",
    users: Number(r.metricValues[0].value || 0),
    sessions: Number(r.metricValues[1].value || 0),
    engagementRate: Number(r.metricValues[2].value || 0),
  }));

  const landingPages = (pagesPayload.rows || []).map((r: any) => ({
    pagePath: r.dimensionValues[0].value || "/",
    users: Number(r.metricValues[0].value || 0),
    sessions: Number(r.metricValues[1].value || 0),
    bounceRate: Number(r.metricValues[2].value || 0),
    engagementRate: Number(r.metricValues[3].value || 0),
    avgEngagementTimeSec: Number(r.metricValues[4].value || 0),
  }));

  const countries = (countriesPayload.rows || []).map((r: any) => ({
    country: formatCountryName(r.dimensionValues[0].value),
    countryCode: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value || 0),
    sessions: Number(r.metricValues[1].value || 0),
  }));

  const totalDevUsers = (devicesPayload.rows || []).reduce((acc: number, r: any) => acc + Number(r.metricValues[0].value || 0), 0) || 1;
  const deviceCategories = (devicesPayload.rows || []).map((r: any) => {
    const users = Number(r.metricValues[0].value || 0);
    return {
      device: r.dimensionValues[0].value,
      users,
      percentage: Math.round((users / totalDevUsers) * 100),
    };
  });

  const browsers = (browsersPayload.rows || []).map((r: any) => ({
    browser: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value || 0),
  }));

  const os = (osPayload.rows || []).map((r: any) => ({
    os: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value || 0),
  }));

  const events = (eventsPayload.rows || []).map((r: any) => ({
    eventName: r.dimensionValues[0].value,
    count: Number(r.metricValues[0].value || 0),
    users: Number(r.metricValues[1].value || 0),
  }));

  const conversions = events
    .filter((e: any) => ["purchase", "generate_lead", "sign_up", "conversion", "submit_form"].includes(e.eventName.toLowerCase()))
    .map((e: any) => ({
      eventName: e.eventName,
      count: e.count,
      rate: sessionsKpi.current ? Number((e.count / sessionsKpi.current).toFixed(3)) : 0,
    }));

  let newUsers = 0;
  let returningUsers = 0;
  let avgSessionDurationSec = 0;
  (newVsReturningPayload.rows || []).forEach((r: any) => {
    const type = r.dimensionValues[0].value.toLowerCase();
    const count = Number(r.metricValues[0].value || 0);
    if (type.includes("new")) newUsers += count;
    else returningUsers += count;
    avgSessionDurationSec = Number(r.metricValues[2].value || 0);
  });

  const sessionsPerUser = usersKpi.current ? Number((sessionsKpi.current / usersKpi.current).toFixed(2)) : 1;

  const realtimeActiveUsers = Number(realtimeUsersPayload.rows?.[0]?.metricValues?.[0]?.value || 0);
  const realtimeActivePages = (realtimePagesPayload.rows || []).map((r: any) => ({
    pagePath: r.dimensionValues[0].value,
    activeUsers: Number(r.metricValues[0].value || 0),
  }));

  const seoInsights: Ga4FullReportData["seoInsights"] = [];

  landingPages
    .filter((p: { sessions: number; engagementRate: number }) => p.sessions >= 5 && p.engagementRate < 0.4)
    .slice(0, 3)
    .forEach((p: { pagePath: string; sessions: number; engagementRate: number }, idx: number) => {
      seoInsights.push({
        id: `poor_eng_${idx}`,
        type: "poor_engagement",
        title: `Low Engagement on "${p.pagePath}"`,
        description: `This page received ${p.sessions} sessions but has an engagement rate of only ${(p.engagementRate * 100).toFixed(1)}%. Review page content and layout.`,
        metricLabel: `${(p.engagementRate * 100).toFixed(1)}% Engagement Rate`,
      });
    });

  landingPages
    .filter((p: { sessions: number; bounceRate: number }) => p.sessions >= 5 && p.bounceRate > 0.6)
    .slice(0, 3)
    .forEach((p: { pagePath: string; bounceRate: number }, idx: number) => {
      seoInsights.push({
        id: `bounce_${idx}`,
        type: "high_bounce",
        title: `High Bounce Rate on "${p.pagePath}"`,
        description: `Over ${(p.bounceRate * 100).toFixed(1)}% of visitors leave without navigating further. Optimize above-the-fold content and CTA.`,
        metricLabel: `${(p.bounceRate * 100).toFixed(1)}% Bounce Rate`,
      });
    });

  if (trafficSources.length > 0) {
    const topSource = trafficSources[0];
    seoInsights.push({
      id: "top_source_0",
      type: "growing_source",
      title: `Primary Traffic Driver: "${topSource.channel}"`,
      description: `Generates ${topSource.sessions} sessions (${topSource.users} users) with a ${(topSource.engagementRate * 100).toFixed(1)}% engagement rate.`,
      metricLabel: `${topSource.sessions} Sessions`,
    });
  }

  const { db } = await connectToDatabase();
  await db.collection<IntegrationDocument>("integrations").updateOne(
    { _id: integration._id },
    { $set: { updatedAt: new Date() } }
  );

  const reportResult: Ga4FullReportData = {
    connected: true,
    propertyId,
    propertyDisplayName: integration.ga4PropertyDisplayName,
    lastSynced: new Date().toISOString(),
    dateRange: {
      days,
      startDate: currentStartDate,
      endDate: currentEndDate,
    },
    kpis: {
      users: usersKpi,
      sessions: sessionsKpi,
      engagedSessions: engagedSessionsKpi,
      engagementRate: engagementRateKpi,
      avgEngagementTimeSec: avgEngagementTimeKpi,
      eventCount: eventCountKpi,
    },
    dailySeries,
    trafficSources,
    landingPages,
    countries,
    devices: {
      categories: deviceCategories,
      browsers,
      os,
    },
    realtime: {
      activeUsers: realtimeActiveUsers,
      activePages: realtimeActivePages,
      activeCountries: [],
      activeDevices: [],
    },
    events,
    conversions,
    audience: {
      newUsers,
      returningUsers,
      avgSessionDurationSec,
      sessionsPerUser,
    },
    seoInsights,
  };

  ga4ReportCache.set(cacheKey, { data: reportResult, timestamp: Date.now() });
  return reportResult;
}
