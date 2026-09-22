export interface DomainRouting {
  bucketId: number;
  bucketIdPadded: string;
}

async function sha256HexFirst3(domain: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(domain));
  const bytes = Array.from(new Uint8Array(buffer));
  return bytes
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 3);
}

export async function resolveBucket(domain: string): Promise<DomainRouting> {
  const hex = await sha256HexFirst3(domain);
  const intValue = parseInt(hex, 16);
  const bucketId = intValue >> 2;
  return {
    bucketId,
    bucketIdPadded: String(bucketId).padStart(4, "0"),
  };
}

export const SERVING_PREFIX =
  "link-index/v1/serving/cc-main-2026-30-index-compact-20260911025127-497/serving";

export const R2_BUCKET_NAME = "growthsent-link-index";

export interface TableConfig {
  table: string;
  defaultLimit: number;
  maxLimit: number;
  single: boolean;
}

export const ENDPOINT_TABLES: Record<string, TableConfig> = {
  summary: { table: "domain_summary", defaultLimit: 1, maxLimit: 1, single: true },
  "top-pages": { table: "top_pages", defaultLimit: 50, maxLimit: 1000, single: false },
  anchors: { table: "anchors", defaultLimit: 100, maxLimit: 1000, single: false },
  "referring-domains": { table: "referring_domains", defaultLimit: 100, maxLimit: 1000, single: false },
  "domain-edges": { table: "domain_edges", defaultLimit: 100, maxLimit: 1000, single: false },
  "broken-backlinks": { table: "broken_backlink_candidates", defaultLimit: 50, maxLimit: 500, single: false },
};

export function buildR2Url(tableName: string, bucketIdPadded: string): string {
  return `r2://${R2_BUCKET_NAME}/${SERVING_PREFIX}/table=${tableName}/target_bucket=${bucketIdPadded}/part.parquet`;
}
