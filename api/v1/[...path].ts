import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../lib/api/router.js";
import { initializeDatabaseIndexes } from "../../lib/db/indexes.js";
import { parseBoundedRequestBody } from "../../lib/api/request-body.js";
import { resolveTrustedClientIp } from "../../lib/api/client-ip.js";

let indexesReady: Promise<void> | null = null;

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
  try {
    // Index provisioning is a deliberate operator action, never a side effect
    // of normal request traffic. Unique definitions remain duplicate-audited.
    if (process.env.PROVISION_MONGODB_INDEXES === "true") {
      await ensureIndexes();
    }

    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = urlObj.pathname;

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

    res.end(JSON.stringify(apiRes.body));
  } catch (err) {
    console.error("[Vercel handler] Request failed.", { errorType: err instanceof Error ? err.name : "UnknownError" });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: { code: "SERVER_ERROR", message: "A server error occurred." },
      })
    );
  }
}
