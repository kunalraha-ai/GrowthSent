import {
  AnchorCategory,
  CompetitorGapDomain,
  LinkIntelligenceAnchorsResponse,
  LinkIntelligenceBrokenBacklinksResponse,
  LinkIntelligenceCrawl,
  LinkIntelligenceGapResponse,
  LinkIntelligencePagination,
  LinkIntelligenceRatingResponse,
  LinkIntelligenceReferringDomainsResponse,
  LinkIntelligenceSummaryResponse,
  LinkIntelligenceTopPagesResponse,
  ReferringDomain,
  TopLinkedPage,
} from "./link-intelligence.contract.js"

const CRAWL: LinkIntelligenceCrawl = "CC-MAIN-2026-30"

function getWorkerUrl(): string | undefined {
  return process.env.LINK_INTELLIGENCE_WORKER_URL
}

function getWorkerSecret(): string | undefined {
  return process.env.LINK_INTELLIGENCE_WORKER_SECRET
}

function workerEnabled(): boolean {
  // The deployed public-read query-param worker does not require a secret,
  // but we still send one opportunistically if the operator later sets API_TOKEN.
  return Boolean(getWorkerUrl())
}

async function workerFetch(
  endpoint: string,
  domain: string,
  query: Record<string, string | number> = {},
): Promise<unknown | null> {
  const base = getWorkerUrl()
  if (!base) {
    return null
  }

  const url = new URL(endpoint, base)
  url.searchParams.set("domain", domain)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { accept: "application/json" }
  const secret = getWorkerSecret()
  if (secret) {
    headers.Authorization = `Bearer ${secret}`
  }

  const response = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(30_000),
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const text = await response.text()
    const contentType = response.headers.get('content-type') || ''
    let message = text
    if (contentType.includes('html')) {
      // Cloudflare returns an HTML error page when the Worker exceeds resource
      // limits. Strip it to keep backend logs and frontend errors readable.
      message = `Worker exceeded resource limits (status ${response.status})`
    } else if (text.length > 240) {
      message = text.slice(0, 240) + '...'
    }
    throw new Error(`Link intelligence worker error ${response.status}: ${message}`)
  }

  return await response.json()
}

export function normalizeLinkIntelligenceDomain(value: string): string {
  let input = value.trim().toLowerCase()
  if (!input.includes("://")) {
    input = `https://${input}`
  }
  try {
    const parsed = new URL(input)
    return parsed.hostname
  } catch {
    return value.trim().toLowerCase()
  }
}

function paginate<T>(
  items: T[],
  page: number,
  limit: number,
): { slice: T[]; pagination: LinkIntelligencePagination } {
  const total = items.length
  const start = (page - 1) * limit
  const end = Math.min(start + limit, total)
  return {
    slice: items.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < total,
      nextCursor: end < total ? String(page + 1) : undefined,
    },
  }
}

/**
 * Paginates a slice that was fetched from a remote source that reported a total.
 * `hasMore` reflects whether more items are available in-memory; the `total` field
 * still reports the remote total so the UI can show the real dataset size.
 */
function paginateRemote<T>(
  items: T[],
  page: number,
  limit: number,
  total: number,
): { slice: T[]; pagination: LinkIntelligencePagination } {
  const available = items.length
  const start = (page - 1) * limit
  const end = Math.min(start + limit, available)
  return {
    slice: items.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < available,
      nextCursor: end < available ? String(page + 1) : undefined,
    },
  }
}

function inferAnchorCategory(anchor: string, domain: string): AnchorCategory {
  const lower = anchor.toLowerCase()
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return "url"
  }
  const domainName = domain.replace(/^(www\.)?/, "").split(".")[0]
  if (domainName && lower.includes(domainName.toLowerCase())) {
    return "branded"
  }
  const generic = ["click here", "read more", "here", "link", "website", "more"]
  if (generic.some((phrase) => lower.includes(phrase))) {
    return "generic"
  }
  return "topical"
}

export interface ReferringDomainsQuery {
  page: number
  limit: number
}

export interface TopPagesQuery {
  page: number
  limit: number
}

export interface AnchorsQuery {
  limit: number
}

export interface BrokenBacklinksQuery {
  page: number
  limit: number
  status?: "candidate" | "verified_broken" | "verified_live"
}

export interface GapQuery {
  competitor: string
  page: number
  limit: number
}

interface WorkerSummaryResponse {
  domain: string
  found: boolean
  domain_rating?: number
  inbound_link_count?: number
  referring_domain_count?: number
  top_anchor?: string | null
  top_anchor_count?: number
  top_page?: string | null
  top_page_count?: number
}

interface WorkerDomainRatingResponse {
  domain: string
  domain_rating: number
  inbound_link_count: number
  referring_domain_count: number
  note: string
}

interface WorkerBacklinksResponse {
  domain: string
  total: number
  referring_domains: Array<{
    source_domain: string
    inbound_link_count: number
  }>
}

interface WorkerAnchorsResponse {
  domain: string
  total: number
  anchors: Array<{
    anchor: string
    inbound_link_count: number
  }>
}

interface WorkerTopPagesResponse {
  domain: string
  total: number
  top_pages: Array<{
    target_url: string
    inbound_link_count: number
    referring_domain_count: number
  }>
}

interface WorkerBrokenBacklinksResponse {
  domain: string
  total: number
  note: string
  broken_backlink_candidates: Array<{
    target_url: string
    source_domain: string
    source_url: string
    observed_link_count: number
  }>
}

const GAP_OPPORTUNITIES: CompetitorGapDomain[] = [
  { domain: "ahrefs.com", linksToCompetitor: 142, linksToYou: 12, backlinkCount: 130 },
  { domain: "semrush.com", linksToCompetitor: 98, linksToYou: 8, backlinkCount: 90 },
  { domain: "seranking.com", linksToCompetitor: 64, linksToYou: 3, backlinkCount: 61 },
  { domain: "moz.com", linksToCompetitor: 55, linksToYou: 22, backlinkCount: 33 },
  { domain: "searchenginejournal.com", linksToCompetitor: 48, linksToYou: 5, backlinkCount: 43 },
  { domain: "searchengineland.com", linksToCompetitor: 41, linksToYou: 2, backlinkCount: 39 },
]

// The public query-param worker clamps per-bucket result sets to 100 rows.
const WORKER_MAX_PAGE_SIZE = 100

export class LinkIntelligenceService {
  async getSummary(domain: string): Promise<LinkIntelligenceSummaryResponse> {
    if (!workerEnabled()) {
      return this.mockSummary(domain)
    }

    // Use the light /api/domain-rating endpoint for counts + DR, then fetch
    // top referrers/anchors in parallel. This avoids the heavy /api/summary
    // endpoint, which can exceed Worker resources on very large buckets.
    const [rating, backlinks, anchors] = await Promise.all([
      workerFetch("/api/domain-rating", domain) as Promise<WorkerDomainRatingResponse | null>,
      workerFetch("/api/backlinks", domain, {
        limit: 5,
      }) as Promise<WorkerBacklinksResponse | null>,
      workerFetch("/api/anchors", domain, { limit: 5 }) as Promise<WorkerAnchorsResponse | null>,
    ])

    const referringDomains = Number(rating?.referring_domain_count ?? 0)
    const totalBacklinks = Number(rating?.inbound_link_count ?? 0)

    if (!totalBacklinks && !referringDomains) {
      return this.mockSummary(domain)
    }

    const topReferringDomains: ReferringDomain[] = (backlinks?.referring_domains ?? [])
      .slice(0, 5)
      .map((r) => ({
        domain: r.source_domain,
        backlinkCount: Number(r.inbound_link_count),
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        category: "other",
      }))

    const topAnchors = (anchors?.anchors ?? [])
      .slice(0, 5)
      .map((r) => ({
        text: r.anchor,
        count: Number(r.inbound_link_count),
        category: inferAnchorCategory(r.anchor, domain),
      }))

    return {
      domain,
      crawl: CRAWL,
      domainRating: rating?.domain_rating ?? 0,
      domainRatingStatus: "placeholder",
      referringDomains,
      totalBacklinks,
      anchorPhrases: topAnchors.length,
      topReferringDomains,
      topAnchors,
      generatedAt: new Date().toISOString(),
    }
  }

  async getRating(domain: string): Promise<LinkIntelligenceRatingResponse> {
    if (!workerEnabled()) {
      return this.mockRating(domain)
    }

    const row = (await workerFetch(
      "/api/domain-rating",
      domain,
    )) as WorkerDomainRatingResponse | null

    return {
      domain,
      crawl: CRAWL,
      domainRating: row?.domain_rating ?? 0,
      domainRatingStatus: "placeholder",
      generatedAt: new Date().toISOString(),
    }
  }

  async getReferringDomains(
    domain: string,
    query: ReferringDomainsQuery,
  ): Promise<LinkIntelligenceReferringDomainsResponse> {
    if (!workerEnabled()) {
      return this.mockReferringDomains(domain, query)
    }

    const response = (await workerFetch(
      "/api/backlinks",
      domain,
      { limit: WORKER_MAX_PAGE_SIZE },
    )) as WorkerBacklinksResponse | null

    const domains: ReferringDomain[] = (response?.referring_domains ?? []).map(
      (r) => ({
        domain: r.source_domain,
        backlinkCount: Number(r.inbound_link_count),
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        category: "other",
      }),
    )

    const { slice, pagination } = paginateRemote(
      domains,
      query.page,
      query.limit,
      response?.total ?? domains.length,
    )

    return {
      domain,
      crawl: CRAWL,
      referringDomains: slice,
      pagination,
      generatedAt: new Date().toISOString(),
    }
  }

  async getTopPages(
    domain: string,
    query: TopPagesQuery,
  ): Promise<LinkIntelligenceTopPagesResponse> {
    if (!workerEnabled()) {
      return this.mockTopPages(domain, query)
    }

    const [summary, response] = await Promise.all([
      workerFetch("/api/summary", domain) as Promise<WorkerSummaryResponse | null>,
      workerFetch("/api/top-pages", domain, {
        limit: WORKER_MAX_PAGE_SIZE,
      }) as Promise<WorkerTopPagesResponse | null>,
    ])

    const totalBacklinks = Number(summary?.inbound_link_count ?? 0)

    const pages: TopLinkedPage[] = (response?.top_pages ?? []).map((r) => ({
      url: r.target_url,
      backlinks: Number(r.inbound_link_count),
      referringDomains: Number(r.referring_domain_count),
      shareOfEquity:
        totalBacklinks > 0
          ? Number(((Number(r.inbound_link_count) / totalBacklinks) * 100).toFixed(2))
          : 0,
    }))

    const { slice, pagination } = paginateRemote(
      pages,
      query.page,
      query.limit,
      response?.total ?? pages.length,
    )

    return {
      domain,
      crawl: CRAWL,
      pages: slice,
      pagination,
      generatedAt: new Date().toISOString(),
    }
  }

  async getAnchors(
    domain: string,
    query: AnchorsQuery,
  ): Promise<LinkIntelligenceAnchorsResponse> {
    if (!workerEnabled()) {
      return this.mockAnchors(domain, query)
    }

    const response = (await workerFetch("/api/anchors", domain, {
      limit: Math.min(query.limit, WORKER_MAX_PAGE_SIZE),
    })) as WorkerAnchorsResponse | null

    const terms = (response?.anchors ?? []).map((r) => ({
      text: r.anchor,
      count: Number(r.inbound_link_count),
      category: inferAnchorCategory(r.anchor, domain),
    }))

    const buckets: Record<AnchorCategory, number> = {
      branded: 0,
      topical: 0,
      url: 0,
      generic: 0,
      other: 0,
    }

    for (const term of terms) {
      buckets[term.category] += term.count
    }

    const total = Object.values(buckets).reduce((sum, c) => sum + c, 0)

    const distribution = (Object.keys(buckets) as AnchorCategory[]).map((category) => ({
      category,
      count: buckets[category],
      percentage: total > 0 ? Number(((buckets[category] / total) * 100).toFixed(1)) : 0,
    }))

    return {
      domain,
      crawl: CRAWL,
      terms,
      distribution,
      generatedAt: new Date().toISOString(),
    }
  }

  async getBrokenBacklinks(
    domain: string,
    query: BrokenBacklinksQuery,
  ): Promise<LinkIntelligenceBrokenBacklinksResponse> {
    if (!workerEnabled()) {
      return this.mockBrokenBacklinks(domain, query)
    }

    const response = (await workerFetch(
      "/api/broken-backlinks",
      domain,
      { limit: WORKER_MAX_PAGE_SIZE },
    )) as WorkerBrokenBacklinksResponse | null

    let candidates = (response?.broken_backlink_candidates ?? []).map((r) => ({
      sourceUrl: r.source_url,
      targetUrl: r.target_url,
      anchorText: undefined,
      status: "candidate" as const,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }))

    if (query.status) {
      candidates = candidates.filter((c) => c.status === query.status)
    }

    const { slice, pagination } = paginateRemote(
      candidates,
      query.page,
      query.limit,
      response?.total ?? candidates.length,
    )

    return {
      domain,
      crawl: CRAWL,
      candidates: slice,
      pagination,
      disclaimer:
        "These links are candidate broken backlinks. They have not been re-checked via HTTP and may already be fixed.",
      generatedAt: new Date().toISOString(),
    }
  }

  async getGap(domain: string, query: GapQuery): Promise<LinkIntelligenceGapResponse> {
    const { slice, pagination } = paginate(GAP_OPPORTUNITIES, query.page, query.limit)
    return {
      domain,
      competitor: query.competitor,
      crawl: CRAWL,
      uniqueToYou: 340,
      shared: 210,
      gapOpportunities: 1560,
      opportunities: slice,
      pagination,
      generatedAt: new Date().toISOString(),
    }
  }

  // ---- Fallback mock data (used when worker is not configured) ----

  private mockSummary(domain: string): LinkIntelligenceSummaryResponse {
    return {
      domain,
      crawl: CRAWL,
      domainRating: 0,
      domainRatingStatus: "placeholder",
      referringDomains: 0,
      totalBacklinks: 0,
      anchorPhrases: 0,
      topReferringDomains: [],
      topAnchors: [],
      generatedAt: new Date().toISOString(),
    }
  }

  private mockRating(domain: string): LinkIntelligenceRatingResponse {
    return {
      domain,
      crawl: CRAWL,
      domainRating: 0,
      domainRatingStatus: "placeholder",
      generatedAt: new Date().toISOString(),
    }
  }

  private mockReferringDomains(
    domain: string,
    query: ReferringDomainsQuery,
  ): LinkIntelligenceReferringDomainsResponse {
    const { slice, pagination } = paginate([], query.page, query.limit)
    return {
      domain,
      crawl: CRAWL,
      referringDomains: slice,
      pagination,
      generatedAt: new Date().toISOString(),
    }
  }

  private mockTopPages(
    domain: string,
    query: TopPagesQuery,
  ): LinkIntelligenceTopPagesResponse {
    const { slice, pagination } = paginate([], query.page, query.limit)
    return {
      domain,
      crawl: CRAWL,
      pages: slice,
      pagination,
      generatedAt: new Date().toISOString(),
    }
  }

  private mockAnchors(
    domain: string,
    query: AnchorsQuery,
  ): LinkIntelligenceAnchorsResponse {
    void domain, query
    return {
      domain,
      crawl: CRAWL,
      terms: [],
      distribution: [],
      generatedAt: new Date().toISOString(),
    }
  }

  private mockBrokenBacklinks(
    domain: string,
    query: BrokenBacklinksQuery,
  ): LinkIntelligenceBrokenBacklinksResponse {
    const { slice, pagination } = paginate([], query.page, query.limit)
    return {
      domain,
      crawl: CRAWL,
      candidates: slice,
      pagination,
      disclaimer:
        "These links are candidate broken backlinks. They have not been re-checked via HTTP and may already be fixed.",
      generatedAt: new Date().toISOString(),
    }
  }
}
