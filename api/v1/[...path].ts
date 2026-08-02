import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../lib/api/router";
import { initializeDatabaseIndexes } from "../../lib/db/indexes";

let indexesReady: Promise<void> | null = null;

function ensureIndexes() {
  if (!indexesReady) indexesReady = initializeDatabaseIndexes();
  return indexesReady;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ensureIndexes();
  const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = urlObj.pathname;

  // The analytics tracking snippet runs on third-party customer domains (not this app's
  // own origin), so its collect endpoint needs permissive CORS. It carries no cookies
  // or credentials, so a wildcard origin is safe here — and is scoped ONLY to this one
  // public route, never applied to authenticated endpoints.
  const isPublicCollectRoute = /^\/api\/v1\/websites\/[a-f0-9]{24}\/analytics\/collect$/.test(path);
  if (isPublicCollectRoute) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
  }

  let body: any = null;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
    const buffers: Buffer[] = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const raw = Buffer.concat(buffers).toString("utf-8");
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
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
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "127.0.0.1",
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
}
