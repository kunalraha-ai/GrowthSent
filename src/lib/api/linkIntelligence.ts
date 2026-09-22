import {
  LinkIntelligenceAnchorsResponse,
  LinkIntelligenceBrokenBacklinksResponse,
  LinkIntelligenceGapResponse,
  LinkIntelligenceRatingResponse,
  LinkIntelligenceReferringDomainsResponse,
  LinkIntelligenceSummaryResponse,
  LinkIntelligenceTopPagesResponse,
} from "@/modules/backlinks/dtos/link-intelligence.dto"
import {
  mockSummary,
  mockRating,
  mockReferringDomains,
  mockTopPages,
  mockAnchors,
  mockBrokenBacklinks,
  mockGap,
} from "./linkIntelligence.fixture"

export type { LinkIntelligenceSummaryResponse }

const DEV_MOCK_ENABLED = import.meta.env.DEV

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : "Request failed"
    const code =
      typeof payload?.error?.code === "string"
        ? payload.error.code
        : "UNKNOWN_ERROR"
    throw new LinkIntelligenceApiError(message, code, response.status)
  }
  return payload.data as T
}

export class LinkIntelligenceApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = "LinkIntelligenceApiError"
  }
}

function encodeDomain(domain: string): string {
  return encodeURIComponent(domain)
}

export function getLinkIntelligenceSummary(
  domain: string,
): Promise<LinkIntelligenceSummaryResponse> {
  return fetchJson<LinkIntelligenceSummaryResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/summary`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: summary", err)
      return mockSummary(domain)
    }
    throw err
  })
}

export function getLinkIntelligenceRating(
  domain: string,
): Promise<LinkIntelligenceRatingResponse> {
  return fetchJson<LinkIntelligenceRatingResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/rating`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: rating", err)
      return mockRating(domain)
    }
    throw err
  })
}

export function getLinkIntelligenceReferringDomains(
  domain: string,
  page = 1,
  limit = 20,
): Promise<LinkIntelligenceReferringDomainsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  return fetchJson<LinkIntelligenceReferringDomainsResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/referring-domains?${params.toString()}`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: referring-domains", err)
      return mockReferringDomains(domain, page, limit)
    }
    throw err
  })
}

export function getLinkIntelligenceTopPages(
  domain: string,
  page = 1,
  limit = 20,
): Promise<LinkIntelligenceTopPagesResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  return fetchJson<LinkIntelligenceTopPagesResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/top-pages?${params.toString()}`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: top-pages", err)
      return mockTopPages(domain, page, limit)
    }
    throw err
  })
}

export function getLinkIntelligenceAnchors(
  domain: string,
  limit = 50,
): Promise<LinkIntelligenceAnchorsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  return fetchJson<LinkIntelligenceAnchorsResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/anchors?${params.toString()}`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: anchors", err)
      return mockAnchors(domain, limit)
    }
    throw err
  })
}

export function getLinkIntelligenceBrokenBacklinks(
  domain: string,
  page = 1,
  limit = 20,
): Promise<LinkIntelligenceBrokenBacklinksResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  return fetchJson<LinkIntelligenceBrokenBacklinksResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/broken-backlinks?${params.toString()}`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: broken-backlinks", err)
      return mockBrokenBacklinks(domain, page, limit)
    }
    throw err
  })
}

export function getLinkIntelligenceGap(
  domain: string,
  competitor: string,
  page = 1,
  limit = 20,
): Promise<LinkIntelligenceGapResponse> {
  const params = new URLSearchParams({
    competitor,
    page: String(page),
    limit: String(limit),
  })
  return fetchJson<LinkIntelligenceGapResponse>(
    `/api/v1/link-intelligence/${encodeDomain(domain)}/gap?${params.toString()}`,
  ).catch((err) => {
    if (DEV_MOCK_ENABLED) {
      console.warn("[link-intelligence] dev fallback: gap", err)
      return mockGap(domain, competitor, page, limit)
    }
    throw err
  })
}
