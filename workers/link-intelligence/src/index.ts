import {
  errorResponse,
  handleAnchors,
  handleBrokenBacklinks,
  handleReferringDomains,
  handleSummary,
  handleTopPages,
} from "./handlers.js";
import type { Env } from "./types.js";

/**
 * GrowthSent Link Intelligence Worker
 *
 * Exposes domain-level link data from the R2 serving tables. All reads are
 * range-based Parquet scans against the bucket that owns the requested domain.
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handleFetch(request, env, ctx);
    return response;
  },
};

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    if (!authorize(request, env)) {
      return new Response(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Only allow GET for read-only serving API.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method not allowed", code: "METHOD_NOT_ALLOWED" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cached response check.
    const cacheKey = new Request(request.url, request);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    const handler = matchRoute(path);
    if (!handler) {
      return new Response(JSON.stringify({ error: "not found", code: "ROUTE_NOT_FOUND" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = await handler(request, env);
    ctx.waitUntil(cacheResponse(cacheKey, response));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

function authorize(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return true;
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] === env.API_TOKEN;
}

function matchRoute(path: string): ((request: Request, env: Env) => Promise<Response>) | null {
  const domainPattern = "([^/]+)"; // URL-encoded domain from router
  // We strip the worker subpath if present and match the v1 domain endpoints.
  const cleaned = path.replace(/\/+$/, "");

  const summary = new RegExp(`^/v1/domains/${domainPattern}/summary$`);
  const referring = new RegExp(`^/v1/domains/${domainPattern}/referring-domains$`);
  const anchors = new RegExp(`^/v1/domains/${domainPattern}/anchors$`);
  const topPages = new RegExp(`^/v1/domains/${domainPattern}/top-pages$`);
  const broken = new RegExp(`^/v1/domains/${domainPattern}/broken-backlinks$`);

  if (summary.test(cleaned)) return handleSummary;
  if (referring.test(cleaned)) return handleReferringDomains;
  if (anchors.test(cleaned)) return handleAnchors;
  if (topPages.test(cleaned)) return handleTopPages;
  if (broken.test(cleaned)) return handleBrokenBacklinks;

  return null;
}

async function cacheResponse(request: Request, response: Response): Promise<void> {
  if (response.status !== 200) return;
  const clone = response.clone();
  await caches.default.put(request, clone);
}
