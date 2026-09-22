import { init, DuckDB, AccessMode, type Connection } from "@ducklings/workers";
import wasmModule from "@ducklings/workers/wasm";
import {
  buildR2Url,
  ENDPOINT_TABLES,
  resolveBucket,
  type TableConfig,
} from "./domain-router.js";
import {
  cacheKey,
  DEFAULT_CACHE_TTL_SECONDS,
  getCached,
  setCached,
} from "./cache.js";

interface Env {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  WORKER_API_SECRET: string;
  LINK_INTELLIGENCE_CACHE: KVNamespace;
  CACHE_TTL_SECONDS?: string;
}

let db: DuckDB | null = null;
let conn: Connection | null = null;
let initialized = false;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function sanitizeSecretValue(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureInitialized(env: Env): Promise<void> {
  if (initialized && db && conn) {
    return;
  }

  await init({ wasmModule });

  db = new DuckDB({
    accessMode: AccessMode.READ_WRITE,
    lockConfiguration: true,
    customConfig: {
      memory_limit: "100MB",
      preserve_insertion_order: "false",
      threads: "1",
    },
  });
  conn = db.connect();

  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID) {
    const keyId = sanitizeSecretValue(env.R2_ACCESS_KEY_ID);
    const secret = sanitizeSecretValue(env.R2_SECRET_ACCESS_KEY);
    const accountId = sanitizeSecretValue(env.R2_ACCOUNT_ID);
    await conn.execute(
      `CREATE OR REPLACE SECRET r2 (TYPE R2, KEY_ID '${keyId}', SECRET '${secret}', ACCOUNT_ID '${accountId}');`
    );
  }

  initialized = true;
}

function authenticate(request: Request, env: Env): Response | null {
  if (!env.WORKER_API_SECRET) {
    return null;
  }
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.WORKER_API_SECRET}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return null;
}

const DOMAIN_REGEX = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i;

async function parseAndValidateDomain(
  pathname: string
): Promise<{ domain: string; endpoint: string } | null> {
  const match = pathname.match(/^\/v1\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  const [, rawDomain, endpoint] = match;
  const domain = decodeURIComponent(rawDomain);
  if (!DOMAIN_REGEX.test(domain)) {
    return null;
  }
  return { domain, endpoint };
}

function resolveLimit(url: URL, config: TableConfig): number {
  if (config.single) {
    return 1;
  }
  const raw = url.searchParams.get("limit");
  if (!raw) {
    return config.defaultLimit;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return config.defaultLimit;
  }
  return Math.min(parsed, config.maxLimit);
}

async function handleEndpoint(
  request: Request,
  env: Env,
  domain: string,
  endpoint: string
): Promise<Response> {
  const config = ENDPOINT_TABLES[endpoint];
  if (!config) {
    return jsonResponse({ error: `Unknown endpoint: ${endpoint}` }, 404);
  }

  const kv = env.LINK_INTELLIGENCE_CACHE;
  const cacheTtl = env.CACHE_TTL_SECONDS
    ? parseInt(env.CACHE_TTL_SECONDS, 10)
    : DEFAULT_CACHE_TTL_SECONDS;

  const cacheK = cacheKey(config.table, domain);
  const cached = await getCached<unknown>(kv, cacheK);
  if (cached !== null) {
    return jsonResponse({ source: "cache", endpoint, domain, data: cached });
  }

  const { bucketIdPadded } = await resolveBucket(domain);
  const parquetUrl = buildR2Url(config.table, bucketIdPadded);
  const limit = resolveLimit(new URL(request.url), config);

  const escapedDomain = domain.replace(/'/g, "''");

  const rows = await conn!.query(
    `SELECT * FROM '${parquetUrl}' WHERE target_domain = '${escapedDomain}' LIMIT ${limit}`
  );

  const data = config.single ? rows[0] ?? null : rows;

  await setCached(kv, cacheK, data, cacheTtl);

  return jsonResponse(
    { source: "query", endpoint, domain, bucketIdPadded, data },
    data === null || (config.single && data === null) ? 404 : 200
  );
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: JSON_HEADERS });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authError = authenticate(request, env);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const pathname = url.pathname.toLowerCase();

  if (pathname === "/" || pathname === "/health") {
    return jsonResponse({
      name: "link-intelligence-worker",
      endpoints: Object.keys(ENDPOINT_TABLES).map((e) => `/v1/:domain/${e}`),
    });
  }

  try {
    await ensureInitialized(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "DuckDB init failed";
    console.error("[worker] DuckDB initialization failed", error);
    return jsonResponse({ error: message }, 500);
  }

  const parsed = await parseAndValidateDomain(pathname);
  if (!parsed) {
    return jsonResponse({ error: "Invalid path. Use /v1/:domain/:endpoint" }, 400);
  }

  try {
    return await handleEndpoint(request, env, parsed.domain, parsed.endpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query failed";
    console.error("[worker] Query failed", error);
    try {
      await conn!.execute("ROLLBACK");
    } catch {
      // ignore if no active transaction
    }
    return jsonResponse(
      {
        error: message,
        errorType: typeof error === "object" && error !== null ? error.constructor.name : "unknown",
        raw: String(error),
      },
      500
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    return handleRequest(request, env);
  },
};
