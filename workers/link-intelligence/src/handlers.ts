import { R2ParquetBuffer, objectSize } from "./r2.js";
import { domainBucket, normalizeDomain } from "./domain.js";
import { encodeCursor, parsePagination } from "./pagination.js";
import { readDomainRows, readDomainSummary } from "./parquet.js";
import { toNumber } from "./numbers.js";
import type {
  Anchor,
  ApiResponse,
  BrokenBacklinkCandidate,
  DomainSummary,
  Env,
  PaginationInfo,
  ReferringDomain,
  TopPage,
} from "./types.js";

function objectKey(env: Env, table: string, bucket: number): string {
  // Bucket numbers are zero-padded to 4 digits to match the compactor output.
  return `${env.SERVING_PREFIX}/serving/table=${table}/target_bucket=${bucket.toString().padStart(4, "0")}/part.parquet`;
}

async function getParquetBuffer(env: Env, table: string, bucket: number): Promise<R2ParquetBuffer> {
  const key = objectKey(env, table, bucket);
  const size = await objectSize(env.INDEX_BUCKET, key);
  if (size === null) {
    throw new DomainNotFoundError(`${table} bucket ${bucket} is missing`);
  }
  return new R2ParquetBuffer(env.INDEX_BUCKET, key, size);
}

function createResponse<T>(
  domain: string,
  normalizedDomain: string,
  bucket: number,
  table: string,
  data: T[],
  pagination: PaginationInfo,
  env: Env,
): ApiResponse<T> {
  return {
    domain,
    normalized_domain: normalizedDomain,
    target_bucket: bucket,
    table,
    data,
    pagination,
    meta: {
      source_crawl: env.SOURCE_CRAWL,
    },
  };
}

export async function handleSummary(request: Request, env: Env): Promise<Response> {
  const { normalizedDomain, bucket } = await parseDomain(request);
  const buffer = await getParquetBuffer(env, "domain_summary", bucket);

  const summary = await readDomainSummary<DomainSummary>(buffer, normalizedDomain, (row) => ({
    target_domain: String(row.target_domain),
    inbound_link_count: toNumber(row.inbound_link_count),
    referring_domain_count: toNumber(row.referring_domain_count),
    domain_rating: null,
  }));

  if (!summary) {
    return notFound(normalizedDomain);
  }

  return json(createResponse(
    normalizedDomain,
    normalizedDomain,
    bucket,
    "domain_summary",
    [summary],
    { limit: 1, offset: 0, next_cursor: null, total: 1 },
    env,
  ));
}

export async function handleReferringDomains(request: Request, env: Env): Promise<Response> {
  const { normalizedDomain, bucket, limit, offset } = await parseDomainAndPagination(request, env);
  const buffer = await getParquetBuffer(env, "referring_domains", bucket);

  const { rows, total } = await readDomainRows<ReferringDomain>({
    file: buffer,
    columns: ["source_domain", "inbound_link_count"],
    domain: normalizedDomain,
    scoreColumn: "inbound_link_count",
    limit,
    offset,
    build: (row) => ({
      source_domain: String(row.source_domain),
      inbound_link_count: toNumber(row.inbound_link_count),
    }),
  });

  return json(createResponse(
    normalizedDomain,
    normalizedDomain,
    bucket,
    "referring_domains",
    rows,
    { limit, offset, next_cursor: encodeCursor(offset + rows.length), total },
    env,
  ));
}

export async function handleAnchors(request: Request, env: Env): Promise<Response> {
  const { normalizedDomain, bucket, limit, offset } = await parseDomainAndPagination(request, env);
  const buffer = await getParquetBuffer(env, "anchors", bucket);

  const { rows, total } = await readDomainRows<Anchor>({
    file: buffer,
    columns: ["anchor", "inbound_link_count"],
    domain: normalizedDomain,
    scoreColumn: "inbound_link_count",
    limit,
    offset,
    build: (row) => ({
      anchor: String(row.anchor),
      inbound_link_count: toNumber(row.inbound_link_count),
    }),
  });

  return json(createResponse(
    normalizedDomain,
    normalizedDomain,
    bucket,
    "anchors",
    rows,
    { limit, offset, next_cursor: encodeCursor(offset + rows.length), total },
    env,
  ));
}

export async function handleTopPages(request: Request, env: Env): Promise<Response> {
  const { normalizedDomain, bucket, limit, offset } = await parseDomainAndPagination(request, env);
  const buffer = await getParquetBuffer(env, "top_pages", bucket);

  const { rows, total } = await readDomainRows<TopPage>({
    file: buffer,
    columns: ["target_url", "inbound_link_count", "referring_domain_count"],
    domain: normalizedDomain,
    scoreColumn: "inbound_link_count",
    limit,
    offset,
    build: (row) => ({
      target_url: String(row.target_url),
      inbound_link_count: toNumber(row.inbound_link_count),
      referring_domain_count: toNumber(row.referring_domain_count),
    }),
  });

  return json(createResponse(
    normalizedDomain,
    normalizedDomain,
    bucket,
    "top_pages",
    rows,
    { limit, offset, next_cursor: encodeCursor(offset + rows.length), total },
    env,
  ));
}

export async function handleBrokenBacklinks(request: Request, env: Env): Promise<Response> {
  const { normalizedDomain, bucket, limit, offset } = await parseDomainAndPagination(request, env);
  const buffer = await getParquetBuffer(env, "broken_backlink_candidates", bucket);

  const { rows, total } = await readDomainRows<BrokenBacklinkCandidate>({
    file: buffer,
    columns: ["target_url", "source_domain", "source_url", "observed_link_count"],
    domain: normalizedDomain,
    scoreColumn: "observed_link_count",
    limit,
    offset,
    build: (row) => ({
      target_url: String(row.target_url),
      source_domain: String(row.source_domain),
      source_url: String(row.source_url),
      observed_link_count: toNumber(row.observed_link_count),
    }),
  });

  const response = json(createResponse(
    normalizedDomain,
    normalizedDomain,
    bucket,
    "broken_backlink_candidates",
    rows,
    { limit, offset, next_cursor: encodeCursor(offset + rows.length), total },
    env,
  ));
  // Explicitly label these as unverified candidates.
  response.headers.set("X-GrowthSent-Data-Quality", "candidate-unverified");
  return response;
}

async function parseDomain(request: Request): Promise<{ normalizedDomain: string; bucket: number; rawDomain: string }> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/domains\/([^/]+)\/[a-z-]+$/);
  const rawDomain = decodeURIComponent(match?.[1] ?? "");
  const normalizedDomain = normalizeDomain(rawDomain);
  if (!normalizedDomain) {
    throw new ValidationError(`invalid domain: ${rawDomain}`);
  }
  const bucket = await domainBucket(normalizedDomain);
  return { normalizedDomain, bucket, rawDomain };
}

async function parseDomainAndPagination(
  request: Request,
  env: Env,
): Promise<{ normalizedDomain: string; bucket: number; rawDomain: string; limit: number; offset: number }> {
  const { normalizedDomain, bucket, rawDomain } = await parseDomain(request);
  const url = new URL(request.url);
  const { limit, offset } = parsePagination(url.searchParams, env.MAX_LIMIT);
  return { normalizedDomain, bucket, rawDomain, limit, offset };
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? Number(value) : value)), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function notFound(domain: string): Response {
  return json({ error: `domain not found in index: ${domain}`, code: "DOMAIN_NOT_FOUND" }, 404);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return json({ error: error.message, code: "VALIDATION_ERROR" }, 400);
  }
  if (error instanceof DomainNotFoundError) {
    return json({ error: error.message, code: "DOMAIN_NOT_FOUND" }, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("request failed", error);
  return json({ error: message, code: "INTERNAL_ERROR" }, 500);
}

class ValidationError extends Error {}
class DomainNotFoundError extends Error {}
