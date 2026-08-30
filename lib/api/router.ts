import crypto from "node:crypto";
import { z } from "zod";
import { checkRateLimit } from "../ratelimit/limiter.js";
import { validateUrlForScan } from "../security/ssrf.js";
import { validateTurnstileToken } from "../security/turnstile.js";
import {
  getScanByIdForAccess,
  getScanPagesForAccess,
  getScanIssuesForAccess,
  getScanPages,
  getScanIssues,
  createScanShareToken,
  getSharedScanReport,
} from "../scans/service.js";
import { createUser, verifyUserCredentials, deleteUserAccount } from "../auth/user.js";
import { createSession, validateSession, destroySession, buildSessionCookieHeader, extractSessionTokenFromCookie } from "../auth/session.js";
import { createWebsite, getUserWebsites, getWebsiteById, deleteWebsite, getWebsiteScans } from "../websites/service.js";
import { recordAnalyticsEvent } from "../analytics/collector.js";
import { getAnalyticsSummary } from "../analytics/aggregator.js";
import { getAdminStats } from "../admin/service.js";
import { AuditService } from "../services/audit.service.js";
import { AuditTargetValidationError } from "../services/audit-errors.js";
import { CrawlAdmissionError } from "../jobs/crawl-admission.js";
import { dispatchImmediateAuditJob } from "../jobs/immediate-audit.js";
import { handleDurableCrawlCronRequest, hasValidCronAuthorization } from "../jobs/cron-worker.js";
import { getInternalWorkerHealth } from "../jobs/worker-health.js";
import {
  completeGoogleAuthorization,
  createGoogleAuthorizationUrl,
  disconnectGoogleIntegration,
  fetchSearchIntelligenceReport,
  fetchSearchConsoleKeywords,
  fetchSearchConsoleFullReport,
  fetchGoogleAnalyticsReport,
  fetchGa4FullReport,
  getGoogleIntegrationStatus,
  listGoogleAnalyticsProperties,
  setGoogleAnalyticsProperty,
  type GoogleProvider,
} from "../integrations/google.js";
import {
  createGoogleLoginUrl,
  createGithubLoginUrl,
  completeGoogleLogin,
  completeGithubLogin,
} from "../auth/social.js";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { withMongoOperationPhase } from "../db/mongo-diagnostics.js";
import { BacklinkAnalyticsError, getBacklinkAnalytics } from "../backlinks/service.js";
import { BacklinkProtectionError, enforceBacklinkRequestQuota } from "../backlinks/shared-protection.js";
import { logProductionApiHandlerError } from "./production-error-log.js";
import { buildAiReadinessReport } from "../ai-readiness/service.js";

// Input Validation Schemas
export const ScanInputSchema = z.object({
  url: z.string().min(1, "URL is required").max(2048, "URL is too long"),
});

export const AuthSignupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128, "Password is too long"),
  name: z.string().trim().max(200, "Name is too long").optional(),
  turnstileToken: z.string().max(2048, "Invalid human verification token").optional(),
});

export const AuthLoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
  turnstileToken: z.string().max(2048, "Invalid human verification token").optional(),
});

export const WebsiteInputSchema = z.object({
  url: z.string().min(1, "URL or hostname is required"),
  displayName: z.string().optional(),
});

export const AuditInputSchema = z
  .object({
    url: z.string().min(1, "URL is required").max(2048, "URL is too long"),
    websiteId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid website identifier").optional(),
  })
  .strict();

export const AnalyticsCollectSchema = z.object({
  anonymousVisitorId: z.string().min(8).max(128),
  sessionId: z.string().min(8).max(128),
  pageUrl: z.string().url().max(2048),
  referrer: z.string().url().max(2048).optional(),
  userAgent: z.string().max(1024).optional(),
}).strict();

export const Ga4PropertySelectionSchema = z
  .object({
    websiteId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid website identifier"),
    propertyId: z.string().trim().min(1, "propertyId is required").max(128, "propertyId is too long"),
    displayName: z.string().trim().max(256, "displayName is too long").optional(),
  })
  .strict();

const GoogleProviderSchema = z.enum(["google_search_console", "google_analytics"]);

export function normalizeSearchIntelligenceDays(value: string | undefined): number {
  if (!value) return 28;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 28;
  return Math.max(7, Math.min(90, parsed));
}

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface ApiResponse {
  statusCode: number;
  headers?: Record<string, string | string[]>;
  body: any;
  /** Server-only work registered by the Vercel handler after the response. */
  backgroundTask?: () => Promise<unknown>;
}

const OAUTH_CALLBACK_MAX_AGE_SECONDS = 10 * 60;
const SCAN_ACCESS_MAX_AGE_SECONDS = 60 * 60;
const GOOGLE_OAUTH_NONCE_COOKIE = "gs_google_oauth_nonce";
const GITHUB_OAUTH_NONCE_COOKIE = "gs_github_oauth_nonce";
const GOOGLE_INTEGRATION_NONCE_COOKIE = "gs_google_integration_nonce";
const SCAN_ACCESS_COOKIE = "gs_scan_access";
const AUDIT_ACCESS_COOKIE = "gs_audit_access";

function getHeader(headers: ApiRequest["headers"], name: string): string | undefined {
  const direct = headers[name];
  if (direct) return direct;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

function buildHttpOnlyCookie(name: string, value: string, path: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ? "Secure; " : "";
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; ${secure}Max-Age=${maxAgeSeconds}`;
}

function clearHttpOnlyCookie(name: string, path: string): string {
  return buildHttpOnlyCookie(name, "", path, 0);
}

function extractResourceAccessToken(
  req: ApiRequest,
  cookieName: string,
  resourceId: string,
  headerName: string
): string | undefined {
  const headerToken = getHeader(req.headers, headerName);
  if (headerToken && /^[A-Za-z0-9_-]{32,128}$/.test(headerToken)) return headerToken;

  const cookieValue = getCookie(getHeader(req.headers, "cookie"), cookieName);
  const prefix = `${resourceId}.`;
  if (!cookieValue?.startsWith(prefix)) return undefined;
  const token = cookieValue.slice(prefix.length);
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function safeErrorMetadata(error: unknown): { errorName: string; errorCode?: string | number } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorCode = typeof error === "object" && error && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof errorCode === "string" || typeof errorCode === "number"
    ? { errorName, errorCode }
    : { errorName };
}

/**
 * Maps known Google social-login failures to safe operational categories.
 * These are intentionally not returned to the browser: provider responses,
 * user identities, and database details must remain out of request logs.
 */
function googleSocialLoginFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "The Google sign-in request is invalid or has expired. Please try again.") {
    return "state_invalid_or_expired";
  }
  if (message === "Unable to complete Google sign-in. Please try again.") {
    return "provider_token_exchange_failed";
  }
  if (message === "Unable to fetch your Google account profile.") {
    return "provider_profile_fetch_failed";
  }
  if (message === "Google did not provide a verified email address for this account.") {
    return "verified_email_required";
  }
  if (message === "An account with this email already exists. Sign in using its existing method.") {
    return "account_link_conflict";
  }
  return "unknown";
}

type WebsiteRoutePhase = "auth" | "owner_validation" | "website_query";

function logWebsiteRouteTiming(
  phase: WebsiteRoutePhase,
  startedAt: string,
  startedMs: number,
  outcome: "started" | "completed" | "failed",
  extra: Record<string, unknown> = {}
): void {
  console.info("[websites] route timing", {
    phase,
    startedAt,
    elapsedMs: Date.now() - startedMs,
    outcome,
    ...extra,
  });
}

function getFrontendRedirectBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") || "";
}

export function getDashboardRedirect(appUrl: string): string {
  return `${appUrl}/dashboard`;
}

/** Remove worker coordination and anonymous capability fields from API responses. */
function toPublicScan(scan: object): Record<string, unknown> {
  const {
    anonymousAccessTokenHash: _anonymousAccessTokenHash,
    accessToken: _accessToken,
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    attempts: _attempts,
    nextAttemptAt: _nextAttemptAt,
    ownerUserId: _ownerUserId,
    clerkUserId: _clerkUserId,
    anonymousSessionId: _anonymousSessionId,
    commonCrawlRequesterKey: _commonCrawlRequesterKey,
    shareTokenHash: _shareTokenHash,
    shareCreatedAt: _shareCreatedAt,
    error: _error,
    ...publicScan
  } = scan as Record<string, unknown>;
  return publicScan.status === "failed"
    ? { ...publicScan, error: "Crawl could not be completed." }
    : publicScan;
}

function toPublicAuditStatus(status: Record<string, unknown>): Record<string, unknown> {
  return status.scan && typeof status.scan === "object"
    ? { ...status, scan: toPublicScan(status.scan) }
    : status;
}

export async function handleApiRequest(req: ApiRequest): Promise<ApiResponse> {
  const ip = req.ip || "127.0.0.1";

  // Enforce IP Rate limit for anonymous scans / general requests
  const rl = checkRateLimit(ip, { maxRequests: 100, windowMs: 60000 });
  if (!rl.allowed) {
    return {
      statusCode: 429,
      body: {
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
        },
      },
    };
  }

  const path = req.path.replace(/\/$/, "");
  const method = req.method.toUpperCase();
  const isWebsiteCollectionRequest = path === "/api/v1/websites" && (method === "GET" || method === "POST");

  // Authentication is based exclusively on the signed, HttpOnly session cookie.
  // Never trust browser-controlled identity headers for account-owned resources.
  try {
    if (method === "GET" && path === "/api/v1/internal/audit-worker") {
      return handleDurableCrawlCronRequest({
        method,
        authorization: getHeader(req.headers, "authorization"),
      });
    }

    if (method === "GET" && path === "/api/v1/internal/audit-worker/health") {
      const authorization = getHeader(req.headers, "authorization");
      if (!hasValidCronAuthorization(authorization, process.env.CRON_SECRET)) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Unauthorized." } } };
      }
      return { statusCode: 200, body: await getInternalWorkerHealth() };
    }

    const sessionToken = extractSessionTokenFromCookie(getHeader(req.headers, "cookie"));
    const authStartedAt = new Date().toISOString();
    const authStartedMs = Date.now();
    let user;
    try {
      user = sessionToken ? await withMongoOperationPhase("session_validation", () => validateSession(sessionToken)) : null;
      if (isWebsiteCollectionRequest) {
        logWebsiteRouteTiming("auth", authStartedAt, authStartedMs, "completed", {
          sessionCookiePresent: Boolean(sessionToken),
          authenticated: Boolean(user),
        });
      }
    } catch (error) {
      if (isWebsiteCollectionRequest) {
        logWebsiteRouteTiming("auth", authStartedAt, authStartedMs, "failed", {
          sessionCookiePresent: Boolean(sessionToken),
          ...safeErrorMetadata(error),
        });
      }
      throw error;
    }
    if (method === "GET" && path === "/api/v1/health") {
      const { db } = await connectToDatabase();
      await db.command({ ping: 1 });
      return { statusCode: 200, body: { status: "ok", database: "connected" } };
    }

    // ----------------------------------------------------
    // COMMON CRAWL BACKLINK PREVIEW
    // ----------------------------------------------------
    if (method === "GET" && path === "/api/v1/backlinks") {
      if (!user) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      }

      const domain = req.query.domain;
      if (!domain) {
        return { statusCode: 400, body: { error: { code: "INVALID_DOMAIN", message: "A domain is required." } } };
      }

      const page = req.query.page && /^\d+$/.test(req.query.page) ? Number.parseInt(req.query.page, 10) : undefined;
      const pageSize = req.query.pageSize && /^\d+$/.test(req.query.pageSize)
        ? Number.parseInt(req.query.pageSize, 10)
        : undefined;

      try {
        await enforceBacklinkRequestQuota(user._id!.toString());
        const report = await getBacklinkAnalytics(domain, { page, pageSize });
        return {
          statusCode: 200,
          headers: { "Cache-Control": "private, max-age=30" },
          body: report,
        };
      } catch (error) {
        if (error instanceof BacklinkProtectionError) {
          return { statusCode: 429, body: { error: { code: error.code, message: error.message } } };
        }
        if (error instanceof BacklinkAnalyticsError) {
          const statusCode = error.code === "INVALID_DOMAIN" ? 400 : error.code === "QUERY_TIMEOUT" ? 504 : 503;
          return { statusCode, body: { error: { code: error.code, message: error.message } } };
        }
        throw error;
      }
    }

    // ----------------------------------------------------
    // GOOGLE OAUTH & INTEGRATIONS
    // ----------------------------------------------------
    const integrationCallbackMatch = path === "/api/v1/integrations/google/callback";
    if (method === "GET" && integrationCallbackMatch) {
      const code = req.query.code;
      const state = req.query.state;
      const browserNonce = getCookie(getHeader(req.headers, "cookie"), GOOGLE_INTEGRATION_NONCE_COOKIE) || "";
      const appUrl = getFrontendRedirectBase() || "/";
      const separator = appUrl.includes("?") ? "&" : "?";
      const clearNonceCookie = clearHttpOnlyCookie(
        GOOGLE_INTEGRATION_NONCE_COOKIE,
        "/api/v1/integrations/google/callback"
      );
      if (!code || !state || !browserNonce) {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}${separator}integrationError=google`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
      try {
        const completed = await completeGoogleAuthorization(code, state, browserNonce);
        return {
          statusCode: 302,
          headers: {
            Location: `${appUrl}${separator}integration=${completed.provider}&websiteId=${completed.websiteId}`,
            "Set-Cookie": clearNonceCookie,
            "Cache-Control": "no-store",
          },
          body: { success: true },
        };
      } catch {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}${separator}integrationError=google`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
    }

    if (method === "GET" && path === "/api/v1/integrations/google/start") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const providerResult = GoogleProviderSchema.safeParse(req.query.provider);
      const websiteId = req.query.websiteId;
      if (!providerResult.success || !websiteId) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "A provider and websiteId are required." } } };
      }
      const website = await getWebsiteById(websiteId, user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      const browserNonce = crypto.randomBytes(32).toString("base64url");
      const authorizationUrl = await createGoogleAuthorizationUrl(
        user._id!.toString(),
        websiteId,
        providerResult.data,
        browserNonce
      );
      return {
        statusCode: 200,
        headers: {
          "Set-Cookie": buildHttpOnlyCookie(
            GOOGLE_INTEGRATION_NONCE_COOKIE,
            browserNonce,
            "/api/v1/integrations/google/callback",
            OAUTH_CALLBACK_MAX_AGE_SECONDS
          ),
          "Cache-Control": "no-store",
        },
        body: { authorizationUrl },
      };
    }

    if (method === "GET" && path === "/api/v1/integrations") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const providerResult = GoogleProviderSchema.safeParse(req.query.provider);
      const websiteId = req.query.websiteId;
      if (!providerResult.success || !websiteId) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "A provider and websiteId are required." } } };
      }
      const website = await getWebsiteById(websiteId, user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      return { statusCode: 200, body: await getGoogleIntegrationStatus(user._id!.toString(), websiteId, providerResult.data) };
    }

    if (method === "DELETE" && path === "/api/v1/integrations") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const providerResult = GoogleProviderSchema.safeParse(req.query.provider);
      const websiteId = req.query.websiteId;
      if (!providerResult.success || !websiteId) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "A provider and websiteId are required." } } };
      }
      const website = await getWebsiteById(websiteId, user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      const success = await disconnectGoogleIntegration(user._id!.toString(), websiteId, providerResult.data);
      return { statusCode: 200, body: { success } };
    }

    if (method === "GET" && path === "/api/v1/search-performance") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      try {
        const queries = await fetchSearchConsoleKeywords(user._id!.toString(), websiteId);
        return { statusCode: 200, body: { queries } };
      } catch (err) {
        const message = getErrorMessage(err);
        const isNotFound = message.includes("No Google Search Console property");
        return {
          statusCode: isNotFound ? 404 : 400,
          body: {
            error: {
              code: isNotFound ? "GSC_PROPERTY_NOT_FOUND" : "GSC_ERROR",
              message: isNotFound ? "No Google Search Console property is configured for this website." : "Unable to load Search Console data.",
            },
          },
        };
      }
    }

    if (method === "GET" && path === "/api/v1/search-intelligence") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      try {
        const report = await fetchSearchIntelligenceReport(
          user._id!.toString(),
          websiteId,
          normalizeSearchIntelligenceDays(req.query.days)
        );
        return { statusCode: 200, body: report };
      } catch (err) {
        const message = getErrorMessage(err);
        const isNotFound = message.includes("No Google Search Console property");
        return {
          statusCode: isNotFound ? 404 : 400,
          body: {
            error: {
              code: isNotFound ? "GSC_PROPERTY_NOT_FOUND" : "GSC_ERROR",
              message: isNotFound ? "No Google Search Console property is configured for this website." : "Unable to load Search Console data.",
            },
          },
        };
      }
    }

    if (method === "GET" && path === "/api/v1/gsc-full-report") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      const days = parseInt(req.query.days || "28", 10) || 28;
      try {
        const report = await fetchSearchConsoleFullReport(user._id!.toString(), websiteId, days);
        return { statusCode: 200, body: report };
      } catch (err) {
        const message = getErrorMessage(err);
        const isNotFound = message.includes("No Google Search Console property");
        return {
          statusCode: isNotFound ? 404 : 400,
          body: {
            error: {
              code: isNotFound ? "GSC_PROPERTY_NOT_FOUND" : "GSC_ERROR",
              message: isNotFound ? "No Google Search Console property is configured for this website." : "Unable to load Search Console data.",
            },
          },
        };
      }
    }

    if (method === "GET" && path === "/api/v1/ga4-properties") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      const properties = await listGoogleAnalyticsProperties(user._id!.toString(), websiteId);
      return { statusCode: 200, body: { properties } };
    }

    if (method === "POST" && path === "/api/v1/ga4-properties/select") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const parsed = Ga4PropertySelectionSchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          statusCode: 400,
          body: { error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message || "Invalid Google Analytics property." } },
        };
      }
      await setGoogleAnalyticsProperty(
        user._id!.toString(),
        parsed.data.websiteId,
        parsed.data.propertyId,
        parsed.data.displayName
      );
      return { statusCode: 200, body: { success: true } };
    }

    if (method === "GET" && path === "/api/v1/ga4-report") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      const days = parseInt(req.query.days || "30", 10);
      try {
        const report = await fetchGoogleAnalyticsReport(user._id!.toString(), websiteId, days);
        return { statusCode: 200, body: report };
      } catch (err) {
        const msg = getErrorMessage(err);
        if (/no google analytics property/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NO_PROPERTY", message: "No Google Analytics property is configured for this website." } } };
        }
        if (/not connected/i.test(msg) || /no active.*integration/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NOT_CONNECTED", message: "Google Analytics is not connected for this website." } } };
        }
        console.warn("[ga4-report] Request failed.");
        return { statusCode: 400, body: { error: { code: "GA4_ERROR", message: "Unable to fetch Google Analytics data." } } };
      }
    }

    if (method === "GET" && path === "/api/v1/ga4-full-report") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const websiteId = req.query.websiteId;
      if (!websiteId) return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId is required." } } };
      const days = parseInt(req.query.days || "28", 10) || 28;
      try {
        const report = await fetchGa4FullReport(user._id!.toString(), websiteId, days);
        return { statusCode: 200, body: report };
      } catch (err) {
        const msg = getErrorMessage(err);
        if (/no google analytics property/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NO_PROPERTY", message: "No Google Analytics property is configured for this website." } } };
        }
        if (/not connected/i.test(msg) || /no active.*integration/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NOT_CONNECTED", message: "Google Analytics is not connected for this website." } } };
        }
        return { statusCode: 400, body: { error: { code: "GA4_ERROR", message: "Unable to fetch Google Analytics data." } } };
      }
    }

    // ----------------------------------------------------
    // SCAN & AUDIT ENDPOINTS
    // ----------------------------------------------------
    if (method === "POST" && path === "/api/v1/audit") {
      const parsed = AuditInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          statusCode: 400,
          body: { error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message || "Invalid audit request." } },
        };
      }

      const { url: targetUrl, websiteId } = parsed.data;
      if (websiteId) {
        if (!user) {
          return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
        }
        const website = await withMongoOperationPhase("audit_website_ownership_query", () =>
          getWebsiteById(websiteId, user._id!.toString())
        );
        if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      }
      let job;
      try {
        job = await AuditService.createCrawlJob(targetUrl, user?._id?.toString(), websiteId, req.ip);
      } catch (error) {
        if (error instanceof AuditTargetValidationError) {
          return {
            statusCode: error.statusCode,
            body: { error: { code: error.code, message: error.message } },
          };
        }
        if (error instanceof CrawlAdmissionError) {
          const statusCode = error.code === "CRAWL_QUEUE_FULL" ? 503 : 429;
          return { statusCode, body: { error: { code: error.code, message: error.message } } };
        }
        throw error;
      }
      const headers = job.accessToken
        ? {
            "Set-Cookie": buildHttpOnlyCookie(
              AUDIT_ACCESS_COOKIE,
              `${job.jobId}.${job.accessToken}`,
              `/api/v1/audit/${job.jobId}`,
              SCAN_ACCESS_MAX_AGE_SECONDS
            ),
          }
        : undefined;
      return {
        statusCode: 202,
        headers,
        body: { jobId: job.jobId, status: job.status },
        // Do not run a crawl inline with the user request. The Vercel handler
        // registers this named, bounded task with waitUntil after it replies.
        // The scheduler remains the durable recovery path if capacity is full
        // or the background invocation is interrupted.
        backgroundTask: job.reused ? undefined : () => dispatchImmediateAuditJob(job.jobId),
      };
    }

    const auditMatch = path.match(/^\/api\/v1\/audit\/(job_[a-zA-Z0-9_]+)$/);
    if (method === "GET" && auditMatch) {
      const jobId = auditMatch[1];
      const statusData = await AuditService.getCrawlJobStatus(jobId, {
        userId: user?._id?.toString(),
        accessToken: extractResourceAccessToken(req, AUDIT_ACCESS_COOKIE, jobId, "x-audit-access-token"),
      });
      if (!statusData) {
        return {
          statusCode: 404,
          body: { error: { code: "NOT_FOUND", message: "Job not found." } },
        };
      }
      return { statusCode: 200, body: toPublicAuditStatus(statusData) };
    }

    const shareCreateMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})\/share$/);
    if (method === "POST" && shareCreateMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      const token = await createScanShareToken(shareCreateMatch[1], user._id!.toString());
      if (!token) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Completed audit not found." } } };
      return {
        statusCode: 201,
        headers: { "Cache-Control": "no-store" },
        body: { token },
      };
    }

    const sharedAuditMatch = path.match(/^\/api\/v1\/shared\/audits\/([A-Za-z0-9_-]{32,128})$/);
    if (method === "GET" && sharedAuditMatch) {
      const report = await getSharedScanReport(sharedAuditMatch[1]);
      if (!report) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Shared audit not found." } } };
      return { statusCode: 200, headers: { "Cache-Control": "no-store" }, body: report };
    }

    if (method === "POST" && path === "/api/v1/scans") {
      return {
        statusCode: 410,
        body: { error: { code: "LEGACY_SCAN_DISABLED", message: "This scan endpoint is disabled for the external MVP. Use the bounded audit flow instead." } },
      };
    }

    // GET /api/v1/scans/:id
    const scanMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})$/);
    if (method === "GET" && scanMatch) {
      const scanId = scanMatch[1];
      const scan = await getScanByIdForAccess(scanId, {
        userId: user?._id?.toString(),
        accessToken: extractResourceAccessToken(req, SCAN_ACCESS_COOKIE, scanId, "x-scan-access-token"),
      });
      if (!scan) {
        return {
          statusCode: 404,
          body: { error: { code: "NOT_FOUND", message: "Scan not found." } },
        };
      }
      return { statusCode: 200, body: toPublicScan(scan) };
    }

    // GET /api/v1/scans/:id/pages
    const pagesMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})\/pages$/);
    if (method === "GET" && pagesMatch) {
      const scanId = pagesMatch[1];
      const pages = await getScanPagesForAccess(scanId, {
        userId: user?._id?.toString(),
        accessToken: extractResourceAccessToken(req, SCAN_ACCESS_COOKIE, scanId, "x-scan-access-token"),
      });
      if (!pages) {
        return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Scan not found." } } };
      }
      return { statusCode: 200, body: { pages } };
    }

    // GET /api/v1/scans/:id/issues
    const issuesMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})\/issues$/);
    if (method === "GET" && issuesMatch) {
      const scanId = issuesMatch[1];
      const issues = await getScanIssuesForAccess(scanId, {
        userId: user?._id?.toString(),
        accessToken: extractResourceAccessToken(req, SCAN_ACCESS_COOKIE, scanId, "x-scan-access-token"),
      });
      if (!issues) {
        return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Scan not found." } } };
      }
      return { statusCode: 200, body: { issues } };
    }

    // ----------------------------------------------------
    // AUTH ENDPOINTS
    // ----------------------------------------------------
    // ----------------------------------------------------
    // SOCIAL LOGIN (GOOGLE / GITHUB) — authenticates INTO GrowthSent itself
    // ----------------------------------------------------
    if (method === "GET" && path === "/api/v1/auth/google/start") {
      const browserNonce = crypto.randomBytes(32).toString("base64url");
      try {
        const authorizationUrl = await createGoogleLoginUrl(browserNonce);
        return {
          statusCode: 200,
          headers: {
            "Set-Cookie": buildHttpOnlyCookie(
              GOOGLE_OAUTH_NONCE_COOKIE,
              browserNonce,
              "/api/v1/auth/google/callback",
              OAUTH_CALLBACK_MAX_AGE_SECONDS
            ),
            "Cache-Control": "no-store",
          },
          body: { authorizationUrl },
        };
      } catch (error) {
        console.error("[auth] Google social sign-in could not start.", safeErrorMetadata(error));
        return {
          statusCode: 503,
          body: { error: { code: "OAUTH_UNAVAILABLE", message: "Google sign-in is temporarily unavailable." } },
        };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/google/callback") {
      const appUrl = getFrontendRedirectBase();
      const code = req.query.code;
      const state = req.query.state;
      const browserNonce = getCookie(getHeader(req.headers, "cookie"), GOOGLE_OAUTH_NONCE_COOKIE) || "";
      const clearNonceCookie = clearHttpOnlyCookie(GOOGLE_OAUTH_NONCE_COOKIE, "/api/v1/auth/google/callback");
      if (!code || !state) {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=Google+sign-in+failed`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
      try {
        const loggedInUser = await completeGoogleLogin(code, state, browserNonce);
        const { rawToken } = await createSession(loggedInUser._id!.toString());
        return {
          statusCode: 302,
          headers: { Location: getDashboardRedirect(appUrl), "Set-Cookie": [buildSessionCookieHeader(rawToken), clearNonceCookie], "Cache-Control": "no-store" },
          body: {},
        };
      } catch (error) {
        // Never disclose provider, database, or identity details to a browser.
        // The safe category is enough to distinguish an expired state from a
        // provider exchange or configuration incident in production logs.
        console.warn("[auth] Google social sign-in callback failed.", {
          ...safeErrorMetadata(error),
          category: googleSocialLoginFailureCategory(error),
        });
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=Google+sign-in+failed`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/github/start") {
      const browserNonce = crypto.randomBytes(32).toString("base64url");
      try {
        const authorizationUrl = await createGithubLoginUrl(browserNonce);
        return {
          statusCode: 200,
          headers: {
            "Set-Cookie": buildHttpOnlyCookie(
              GITHUB_OAUTH_NONCE_COOKIE,
              browserNonce,
              "/api/v1/auth/github/callback",
              OAUTH_CALLBACK_MAX_AGE_SECONDS
            ),
            "Cache-Control": "no-store",
          },
          body: { authorizationUrl },
        };
      } catch {
        return {
          statusCode: 503,
          body: { error: { code: "OAUTH_UNAVAILABLE", message: "GitHub sign-in is temporarily unavailable." } },
        };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/github/callback") {
      const appUrl = getFrontendRedirectBase();
      const code = req.query.code;
      const state = req.query.state;
      const browserNonce = getCookie(getHeader(req.headers, "cookie"), GITHUB_OAUTH_NONCE_COOKIE) || "";
      const clearNonceCookie = clearHttpOnlyCookie(GITHUB_OAUTH_NONCE_COOKIE, "/api/v1/auth/github/callback");
      if (!code || !state) {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=GitHub+sign-in+failed`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
      try {
        const loggedInUser = await completeGithubLogin(code, state, browserNonce);
        const { rawToken } = await createSession(loggedInUser._id!.toString());
        return {
          statusCode: 302,
          headers: { Location: getDashboardRedirect(appUrl), "Set-Cookie": [buildSessionCookieHeader(rawToken), clearNonceCookie], "Cache-Control": "no-store" },
          body: {},
        };
      } catch {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=GitHub+sign-in+failed`, "Set-Cookie": clearNonceCookie, "Cache-Control": "no-store" },
          body: {},
        };
      }
    }

    if (method === "POST" && path === "/api/v1/auth/signup") {
      const parse = AuthSignupSchema.safeParse(req.body);
      if (!parse.success) {
        return {
          statusCode: 400,
          body: { error: { code: "INVALID_INPUT", message: parse.error.issues[0]?.message } },
        };
      }
      const humanVerification = await validateTurnstileToken(parse.data.turnstileToken, req.ip);
      if (!humanVerification.ok) {
        return {
          statusCode: humanVerification.statusCode,
          body: { error: { code: "TURNSTILE_VERIFICATION_FAILED", message: humanVerification.message } },
        };
      }
      const newUser = await createUser(parse.data.email, parse.data.password, parse.data.name);
      const { rawToken } = await createSession(newUser._id!.toString());
      return {
        statusCode: 201,
        headers: { "Set-Cookie": buildSessionCookieHeader(rawToken) },
        body: { user: { id: newUser._id, email: newUser.email, name: newUser.name } },
      };
    }

    if (method === "POST" && path === "/api/v1/auth/login") {
      const parse = AuthLoginSchema.safeParse(req.body);
      if (!parse.success) {
        return {
          statusCode: 400,
          body: { error: { code: "INVALID_INPUT", message: parse.error.issues[0]?.message } },
        };
      }
      const humanVerification = await validateTurnstileToken(parse.data.turnstileToken, req.ip);
      if (!humanVerification.ok) {
        return {
          statusCode: humanVerification.statusCode,
          body: { error: { code: "TURNSTILE_VERIFICATION_FAILED", message: humanVerification.message } },
        };
      }
      const verified = await verifyUserCredentials(parse.data.email, parse.data.password);
      if (!verified) {
        return {
          statusCode: 401,
          body: { error: { code: "UNAUTHORIZED", message: "Invalid email or password." } },
        };
      }
      const { rawToken } = await createSession(verified._id!.toString());
      return {
        statusCode: 200,
        headers: { "Set-Cookie": buildSessionCookieHeader(rawToken) },
        body: { user: { id: verified._id, email: verified.email, name: verified.name } },
      };
    }

    if (method === "POST" && path === "/api/v1/auth/logout") {
      if (sessionToken) await destroySession(sessionToken);
      return {
        statusCode: 200,
        headers: { "Set-Cookie": buildSessionCookieHeader("", true) },
        body: { success: true },
      };
    }

    if (method === "GET" && path === "/api/v1/auth/me") {
      if (!user) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      }
      return { statusCode: 200, body: { user: { id: user._id, email: user.email, name: user.name, role: user.role } } };
    }

    if (method === "DELETE" && path === "/api/v1/auth/account") {
      if (!user) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      }
      await deleteUserAccount(user._id!.toString());
      return {
        statusCode: 200,
        headers: { "Set-Cookie": buildSessionCookieHeader("", true) },
        body: { success: true },
      };
    }

    // ----------------------------------------------------
    // WEBSITES ENDPOINTS
    // ----------------------------------------------------
    if (method === "POST" && path === "/api/v1/websites") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const parse = WebsiteInputSchema.safeParse(req.body);
      if (!parse.success) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: parse.error.issues[0]?.message } } };
      }
      const site = await createWebsite({
        userId: user._id!.toString(),
        urlOrHostname: parse.data.url,
        displayName: parse.data.displayName,
      });
      return { statusCode: 201, body: site };
    }

    if (method === "GET" && path === "/api/v1/websites") {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const ownerValidationStartedAt = new Date().toISOString();
      const ownerValidationStartedMs = Date.now();
      let ownerId: string;
      try {
        ownerId = user._id?.toString() || "";
        safeObjectId(ownerId);
        logWebsiteRouteTiming("owner_validation", ownerValidationStartedAt, ownerValidationStartedMs, "completed", {
          ownerIdValid: true,
        });
      } catch (error) {
        logWebsiteRouteTiming("owner_validation", ownerValidationStartedAt, ownerValidationStartedMs, "failed", {
          ownerIdValid: false,
          ...safeErrorMetadata(error),
        });
        throw error;
      }

      const queryStartedAt = new Date().toISOString();
      const queryStartedMs = Date.now();
      try {
        const websites = await getUserWebsites(ownerId);
        logWebsiteRouteTiming("website_query", queryStartedAt, queryStartedMs, "completed", { websiteCount: websites.length });
        return { statusCode: 200, body: { websites } };
      } catch (error) {
        logWebsiteRouteTiming("website_query", queryStartedAt, queryStartedMs, "failed", safeErrorMetadata(error));
        throw error;
      }
    }

    const webIdMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})$/);
    if (method === "GET" && webIdMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(webIdMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      return { statusCode: 200, body: website };
    }

    const aiReadinessMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/ai-readiness$/);
    if (method === "POST" && aiReadinessMatch) {
      if (!user) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      }

      const websiteId = aiReadinessMatch[1];
      const readinessLimit = checkRateLimit(`ai-readiness:${user._id!.toString()}:${websiteId}`, {
        maxRequests: 3,
        windowMs: 60 * 1000,
      });
      if (!readinessLimit.allowed) {
        return {
          statusCode: 429,
          body: { error: { code: "AI_READINESS_RATE_LIMITED", message: "Please wait a minute before running another AI readiness audit for this website." } },
        };
      }

      const website = await getWebsiteById(websiteId, user._id!.toString());
      if (!website) {
        return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      }

      const target = await validateUrlForScan(`https://${website.hostname}/`);
      if (!target.isValid || !target.normalizedUrl) {
        return {
          statusCode: 422,
          body: {
            error: {
              code: "AI_READINESS_TARGET_UNAVAILABLE",
              message: "This website cannot be fetched safely for an AI readiness audit. Check its public hostname and try again.",
            },
          },
        };
      }

      const report = await buildAiReadinessReport(target.normalizedUrl);
      return {
        statusCode: 200,
        headers: { "Cache-Control": "no-store" },
        body: report,
      };
    }

    const latestWebScanMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/latest-scan$/);
    if (method === "GET" && latestWebScanMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(latestWebScanMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      const scans = await getWebsiteScans(latestWebScanMatch[1]);
      const scan = scans.find((candidate) => candidate.status === "completed");
      if (!scan?._id) return { statusCode: 200, body: { scan: null, pages: [], issues: [] } };
      const [pages, issues] = await Promise.all([getScanPages(scan._id.toString()), getScanIssues(scan._id.toString())]);
      return { statusCode: 200, body: { scan: toPublicScan(scan), pages, issues } };
    }

    if (method === "DELETE" && webIdMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const deleted = await deleteWebsite(webIdMatch[1], user._id!.toString());
      if (!deleted) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      return { statusCode: 200, body: { success: true } };
    }

    const webScansMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/scans$/);
    if (method === "GET" && webScansMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(webScansMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      const scans = await getWebsiteScans(webScansMatch[1]);
      return { statusCode: 200, body: { scans: scans.map(toPublicScan) } };
    }

    if (method === "POST" && webScansMatch) {
      return {
        statusCode: 410,
        body: { error: { code: "LEGACY_SCAN_DISABLED", message: "This scan endpoint is disabled for the external MVP. Start a bounded audit from the website dashboard." } },
      };
    }

    // ----------------------------------------------------
    // ANALYTICS ENDPOINTS
    // ----------------------------------------------------
    const analyticsCollectMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/analytics\/collect$/);
    if (method === "POST" && analyticsCollectMatch) {
      if (!user) {
        return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Authentication required." } } };
      }
      const websiteId = analyticsCollectMatch[1];
      const parse = AnalyticsCollectSchema.safeParse(req.body);
      if (!parse.success) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: parse.error.issues[0]?.message } } };
      }
      await recordAnalyticsEvent({
        userId: user._id!.toString(),
        websiteId,
        anonymousVisitorId: parse.data.anonymousVisitorId,
        sessionId: parse.data.sessionId,
        pageUrl: parse.data.pageUrl,
        referrer: parse.data.referrer,
        userAgent: parse.data.userAgent || req.headers["user-agent"],
      });
      return { statusCode: 200, body: { success: true } };
    }

    const analyticsSummaryMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/analytics$/);
    if (method === "GET" && analyticsSummaryMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(analyticsSummaryMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      const days = parseInt(req.query.days || "30", 10);
      const summary = await getAnalyticsSummary(analyticsSummaryMatch[1], days);
      return { statusCode: 200, body: summary };
    }

    // ----------------------------------------------------
    // ADMIN ENDPOINTS
    // ----------------------------------------------------
    if (method === "GET" && path === "/api/v1/admin/stats") {
      if (!user || user.role !== "admin") {
        return { statusCode: 403, body: { error: { code: "FORBIDDEN", message: "Admin privileges required." } } };
      }
      const stats = await getAdminStats();
      return { statusCode: 200, body: stats };
    }

    return {
      statusCode: 404,
      body: { error: { code: "NOT_FOUND", message: `Endpoint ${method} ${path} not found.` } },
    };
  } catch (err) {
    logProductionApiHandlerError("API handler failed.", err, { route: path, method });
    return {
      statusCode: 500,
      body: {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected internal server error occurred.",
        },
      },
    };
  }
}
