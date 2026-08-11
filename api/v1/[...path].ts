import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../lib/api/router.js";
import { initializeDatabaseIndexes } from "../../lib/db/indexes.js";
import { parseBoundedRequestBody } from "../../lib/api/request-body.js";
import { resolveTrustedClientIp } from "../../lib/api/client-ip.js";
import { logProductionApiHandlerError } from "../../lib/api/production-error-log.js";

let indexesReady: Promise<void> | null = null;

function isWebsiteCollectionRequest(path: string): boolean {
  return path === "/api/v1/websites";
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

function ensureIndexes() {
  if (!indexesReady) {
    indexesReady = initializeDatabaseIndexes({
      includeUnique: process.env.PROVISION_MONGODB_UNIQUE_INDEXES === "true",
      auditUniqueIndexes: process.env.PROVISION_MONGODB_UNIQUE_INDEXES === "true",
      includeTtl: process.env.PROVISION_MONGODB_TTL_INDEXES === "true",
    });
  }
  return indexesReady;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let requestPath = "";
  const requestMethod = req.method || "UNKNOWN";
  try {
    // Index provisioning is a deliberate operator action, never a side effect
    // of normal request traffic. Unique definitions remain duplicate-audited.
    if (process.env.PROVISION_MONGODB_INDEXES === "true") {
      await ensureIndexes();
    }

    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = urlObj.pathname;
    requestPath = path;

    let body: any = null;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      const parsed = await parseBoundedRequestBody(req);
      if (parsed.tooLarge) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size." } }));
        return;
      }
      body = parsed.body;
    }

    const query: Record<string, string> = {};
    urlObj.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    const apiReq = {
      method: req.method || "GET",
      path,
      query,
      body,
      headers: req.headers as Record<string, string | undefined>,
      ip: resolveTrustedClientIp(req),
    };

    const apiRes = await handleApiRequest(apiReq);

    res.statusCode = apiRes.statusCode;
    res.setHeader("Content-Type", "application/json");

    if (apiRes.headers) {
      for (const [key, val] of Object.entries(apiRes.headers)) {
        res.setHeader(key, val);
      }
    }

    const serializationStartedAt = new Date().toISOString();
    const serializationStartedMs = Date.now();
    try {
      const body = JSON.stringify(apiRes.body);
      if (isWebsiteCollectionRequest(path)) {
        console.info("[websites] handler timing", {
          phase: "serialization",
          startedAt: serializationStartedAt,
          elapsedMs: Date.now() - serializationStartedMs,
          outcome: "completed",
          statusCode: apiRes.statusCode,
        });
      }
      res.end(body);
    } catch (error) {
      if (isWebsiteCollectionRequest(path)) {
        console.info("[websites] handler timing", {
          phase: "serialization",
          startedAt: serializationStartedAt,
          elapsedMs: Date.now() - serializationStartedMs,
          outcome: "failed",
          ...safeErrorMetadata(error),
        });
      }
      throw error;
    }
  } catch (err) {
    logProductionApiHandlerError("[Vercel handler] Request failed.", err, {
      route: requestPath,
      method: requestMethod,
    });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: { code: "SERVER_ERROR", message: "A server error occurred." },
      })
    );
  }
}
