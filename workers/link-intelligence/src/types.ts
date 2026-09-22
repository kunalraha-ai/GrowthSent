/**
 * Domain-level link intelligence API contract.
 *
 * All endpoints read from the immutable R2 serving tables produced by the
 * CC-MAIN-2026-30 link-index pipeline. Responses are JSON and cacheable.
 */

export interface DomainSummary {
  target_domain: string;
  inbound_link_count: number;
  referring_domain_count: number;
  domain_rating: number | null; // placeholder until graph-scoring job runs
}

export interface ReferringDomain {
  source_domain: string;
  inbound_link_count: number;
}

export interface Anchor {
  anchor: string;
  inbound_link_count: number;
}

export interface TopPage {
  target_url: string;
  inbound_link_count: number;
  referring_domain_count: number;
}

export interface BrokenBacklinkCandidate {
  target_url: string;
  source_domain: string;
  source_url: string;
  observed_link_count: number;
}

export interface PaginationInfo {
  limit: number;
  offset: number;
  next_cursor: string | null;
  total?: number | null;
}

export interface ApiResponse<T> {
  domain: string;
  normalized_domain: string;
  target_bucket: number;
  table: string;
  data: T[];
  pagination: PaginationInfo;
  meta: {
    source_crawl: string;
    freshness_date?: string;
  };
}

export interface Env {
  INDEX_BUCKET: R2Bucket;
  SOURCE_CRAWL: string;
  SERVING_PREFIX: string;
  BUCKET_COUNT: string;
  MAX_LIMIT: string;
  API_TOKEN?: string;
}

export interface Cursor {
  offset: number;
}
