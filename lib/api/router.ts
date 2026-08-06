import { z } from "zod";
import { checkRateLimit } from "../ratelimit/limiter.js";
import { validateUrlForScan } from "../security/ssrf.js";
import { createScan, getScanById, getScanPages, getScanIssues } from "../scans/service.js";
import { createUser, verifyUserCredentials, deleteUserAccount } from "../auth/user.js";
import { createSession, validateSession, destroySession, buildSessionCookieHeader, extractSessionTokenFromCookie } from "../auth/session.js";
import { createWebsite, getUserWebsites, getWebsiteById, deleteWebsite, getWebsiteScans } from "../websites/service.js";
import { recordAnalyticsEvent } from "../analytics/collector.js";
import { getAnalyticsSummary } from "../analytics/aggregator.js";
import { getAdminStats } from "../admin/service.js";
import { AuditService } from "../services/audit.service.js";
import {
  completeGoogleAuthorization,
  createGoogleAuthorizationUrl,
  disconnectGoogleIntegration,
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
import { connectToDatabase } from "../db/mongodb.js";

// Input Validation Schemas
export const ScanInputSchema = z.object({
  url: z.string().min(1, "URL is required"),
});

export const AuthSignupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().optional(),
});

export const AuthLoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const WebsiteInputSchema = z.object({
  url: z.string().min(1, "URL or hostname is required"),
  displayName: z.string().optional(),
});

export const AnalyticsCollectSchema = z.object({
  anonymousVisitorId: z.string().min(1),
  sessionId: z.string().min(1),
  pageUrl: z.string().min(1),
  referrer: z.string().optional(),
  userAgent: z.string().optional(),
});

const GoogleProviderSchema = z.enum(["google_search_console", "google_analytics"]);

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
  headers?: Record<string, string>;
  body: any;
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

  // Authentication is based exclusively on the signed, HttpOnly session cookie.
  // Never trust browser-controlled identity headers for account-owned resources.
  const sessionToken = extractSessionTokenFromCookie(req.headers["cookie"]);
  const user = sessionToken ? await validateSession(sessionToken) : null;

  try {
    if (method === "GET" && path === "/api/v1/health") {
      const { db } = await connectToDatabase();
      await db.command({ ping: 1 });
      return { statusCode: 200, body: { status: "ok", database: "connected" } };
    }

    // ----------------------------------------------------
    // GOOGLE OAUTH & INTEGRATIONS
    // ----------------------------------------------------
    const integrationCallbackMatch = path === "/api/v1/integrations/google/callback";
    if (method === "GET" && integrationCallbackMatch) {
      const code = req.query.code;
      const state = req.query.state;
      if (!code || !state) {
        return { statusCode: 400, body: { error: { code: "INVALID_OAUTH_CALLBACK", message: "Missing Google OAuth code or state." } } };
      }
      const completed = await completeGoogleAuthorization(code, state);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "/";
      const separator = appUrl.includes("?") ? "&" : "?";
      return {
        statusCode: 302,
        headers: { Location: `${appUrl}${separator}integration=${completed.provider}&websiteId=${completed.websiteId}` },
        body: { success: true },
      };
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
      const authorizationUrl = await createGoogleAuthorizationUrl(user._id!.toString(), websiteId, providerResult.data);
      return { statusCode: 200, body: { authorizationUrl } };
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
      } catch (err: any) {
        const message = err?.message || "Unable to load Search Console data.";
        const isNotFound = message.includes("No Google Search Console property");
        return {
          statusCode: isNotFound ? 404 : 400,
          body: { error: { code: isNotFound ? "GSC_PROPERTY_NOT_FOUND" : "GSC_ERROR", message } },
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
      } catch (err: any) {
        const message = err?.message || "Unable to load Search Console data.";
        const isNotFound = message.includes("No Google Search Console property");
        return {
          statusCode: isNotFound ? 404 : 400,
          body: { error: { code: isNotFound ? "GSC_PROPERTY_NOT_FOUND" : "GSC_ERROR", message } },
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
      const websiteId = req.body?.websiteId;
      const propertyId = req.body?.propertyId;
      const displayName = req.body?.displayName;
      if (!websiteId || !propertyId) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "websiteId and propertyId are required." } } };
      }
      await setGoogleAnalyticsProperty(user._id!.toString(), websiteId, propertyId, displayName);
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
      } catch (err: any) {
        const msg: string = err?.message || "Unable to fetch Google Analytics report.";
        if (/no google analytics property/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NO_PROPERTY", message: msg } } };
        }
        if (/not connected/i.test(msg) || /no active.*integration/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NOT_CONNECTED", message: "Google Analytics is not connected for this website." } } };
        }
        console.error("[ga4-report] Error:", msg);
        return { statusCode: 400, body: { error: { code: "GA4_ERROR", message: msg } } };
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
      } catch (err: any) {
        const msg: string = err?.message || "Unable to fetch Google Analytics 4 report.";
        if (/no google analytics property/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NO_PROPERTY", message: msg } } };
        }
        if (/not connected/i.test(msg) || /no active.*integration/i.test(msg)) {
          return { statusCode: 400, body: { error: { code: "NOT_CONNECTED", message: "Google Analytics is not connected for this website." } } };
        }
        return { statusCode: 400, body: { error: { code: "GA4_ERROR", message: msg } } };
      }
    }

    // ----------------------------------------------------
    // SCAN & AUDIT ENDPOINTS
    // ----------------------------------------------------
    if (method === "POST" && path === "/api/v1/audit") {
      const targetUrl = req.body?.url;
      if (!targetUrl || typeof targetUrl !== "string") {
        return {
          statusCode: 400,
          body: { error: { code: "INVALID_INPUT", message: "A valid URL string is required." } },
        };
      }

      const websiteId = req.body?.websiteId;
      if (websiteId && user) {
        const website = await getWebsiteById(websiteId, user._id!.toString());
        if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      }
      const job = await AuditService.createCrawlJob(targetUrl, user?._id?.toString(), websiteId);
      return {
        statusCode: 202,
        body: { jobId: job.jobId, status: job.status },
      };
    }

    const auditMatch = path.match(/^\/api\/v1\/audit\/(job_[a-zA-Z0-9_]+)$/);
    if (method === "GET" && auditMatch) {
      const jobId = auditMatch[1];
      const statusData = await AuditService.getCrawlJobStatus(jobId, user?._id?.toString());
      if (!statusData) {
        return {
          statusCode: 404,
          body: { error: { code: "NOT_FOUND", message: "Job not found." } },
        };
      }
      return { statusCode: 200, body: statusData };
    }

    if (method === "POST" && path === "/api/v1/scans") {
      const parse = ScanInputSchema.safeParse(req.body);
      if (!parse.success) {
        return {
          statusCode: 400,
          body: {
            error: {
              code: "INVALID_URL",
              message: parse.error.issues[0]?.message || "Invalid URL format.",
            },
          },
        };
      }

      const ssrf = await validateUrlForScan(parse.data.url);
      if (!ssrf.isValid) {
        return {
          statusCode: 400,
          body: {
            error: {
              code: "SSRF_BLOCKED",
              message: ssrf.reason || "URL violates security policy.",
            },
          },
        };
      }

      const scan = await createScan({
        url: parse.data.url,
        maxPages: user ? 150 : 50,
      });

      return {
        statusCode: 201,
        body: {
          scanId: scan._id?.toString(),
          status: scan.status,
          url: scan.url,
          createdAt: scan.createdAt,
        },
      };
    }

    // GET /api/v1/scans/:id
    const scanMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})$/);
    if (method === "GET" && scanMatch) {
      const scanId = scanMatch[1];
      const scan = await getScanById(scanId);
      if (!scan) {
        return {
          statusCode: 404,
          body: { error: { code: "NOT_FOUND", message: "Scan not found." } },
        };
      }
      return { statusCode: 200, body: scan };
    }

    // GET /api/v1/scans/:id/pages
    const pagesMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})\/pages$/);
    if (method === "GET" && pagesMatch) {
      const scanId = pagesMatch[1];
      const pages = await getScanPages(scanId);
      return { statusCode: 200, body: { pages } };
    }

    // GET /api/v1/scans/:id/issues
    const issuesMatch = path.match(/^\/api\/v1\/scans\/([a-f0-9]{24})\/issues$/);
    if (method === "GET" && issuesMatch) {
      const scanId = issuesMatch[1];
      const issues = await getScanIssues(scanId);
      return { statusCode: 200, body: { issues } };
    }

    // ----------------------------------------------------
    // AUTH ENDPOINTS
    // ----------------------------------------------------
    // ----------------------------------------------------
    // SOCIAL LOGIN (GOOGLE / GITHUB) — authenticates INTO GrowthSent itself
    // ----------------------------------------------------
    if (method === "GET" && path === "/api/v1/auth/google/start") {
      try {
        const authorizationUrl = await createGoogleLoginUrl();
        return { statusCode: 200, body: { authorizationUrl } };
      } catch (err: any) {
        return { statusCode: 500, body: { error: { code: "OAUTH_NOT_CONFIGURED", message: err.message } } };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/google/callback") {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "/").replace(/\/$/, "");
      const code = req.query.code;
      const state = req.query.state;
      if (!code || !state) {
        return { statusCode: 302, headers: { Location: `${appUrl}/?authError=Missing+Google+OAuth+code` }, body: {} };
      }
      try {
        const loggedInUser = await completeGoogleLogin(code, state);
        const { rawToken } = await createSession(loggedInUser._id!.toString());
        return {
          statusCode: 302,
          headers: { Location: appUrl, "Set-Cookie": buildSessionCookieHeader(rawToken) },
          body: {},
        };
      } catch (err: any) {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=${encodeURIComponent(err.message || "Google sign-in failed.")}` },
          body: {},
        };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/github/start") {
      try {
        const authorizationUrl = await createGithubLoginUrl();
        return { statusCode: 200, body: { authorizationUrl } };
      } catch (err: any) {
        return { statusCode: 500, body: { error: { code: "OAUTH_NOT_CONFIGURED", message: err.message } } };
      }
    }

    if (method === "GET" && path === "/api/v1/auth/github/callback") {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "/").replace(/\/$/, "");
      const code = req.query.code;
      const state = req.query.state;
      if (!code || !state) {
        return { statusCode: 302, headers: { Location: `${appUrl}/?authError=Missing+GitHub+OAuth+code` }, body: {} };
      }
      try {
        const loggedInUser = await completeGithubLogin(code, state);
        const { rawToken } = await createSession(loggedInUser._id!.toString());
        return {
          statusCode: 302,
          headers: { Location: appUrl, "Set-Cookie": buildSessionCookieHeader(rawToken) },
          body: {},
        };
      } catch (err: any) {
        return {
          statusCode: 302,
          headers: { Location: `${appUrl}/?authError=${encodeURIComponent(err.message || "GitHub sign-in failed.")}` },
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
      const websites = await getUserWebsites(user._id!.toString());
      return { statusCode: 200, body: { websites } };
    }

    const webIdMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})$/);
    if (method === "GET" && webIdMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(webIdMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };
      return { statusCode: 200, body: website };
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
      return { statusCode: 200, body: { scan, pages, issues } };
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
      const scans = await getWebsiteScans(webScansMatch[1]);
      return { statusCode: 200, body: { scans } };
    }

    if (method === "POST" && webScansMatch) {
      if (!user) return { statusCode: 401, body: { error: { code: "UNAUTHORIZED", message: "Not authenticated." } } };
      const website = await getWebsiteById(webScansMatch[1], user._id!.toString());
      if (!website) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Website not found." } } };

      const scan = await createScan({
        url: `https://${website.hostname}`,
        websiteId: website._id!.toString(),
        maxPages: 200,
      });
      return { statusCode: 201, body: scan };
    }

    // ----------------------------------------------------
    // ANALYTICS ENDPOINTS
    // ----------------------------------------------------
    const analyticsCollectMatch = path.match(/^\/api\/v1\/websites\/([a-f0-9]{24})\/analytics\/collect$/);
    if (method === "POST" && analyticsCollectMatch) {
      const websiteId = analyticsCollectMatch[1];
      const parse = AnalyticsCollectSchema.safeParse(req.body);
      if (!parse.success) {
        return { statusCode: 400, body: { error: { code: "INVALID_INPUT", message: parse.error.issues[0]?.message } } };
      }
      await recordAnalyticsEvent({
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
  } catch (err: any) {
    console.error("API Handler error:", err);
    return {
      statusCode: 500,
      body: {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: err.message || "An unexpected internal server error occurred.",
        },
      },
    };
  }
}
