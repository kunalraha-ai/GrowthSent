import type {
  LinkIntelligenceSummaryResponse,
  LinkIntelligenceRatingResponse,
  LinkIntelligenceReferringDomainsResponse,
  LinkIntelligenceTopPagesResponse,
  LinkIntelligenceAnchorsResponse,
  LinkIntelligenceBrokenBacklinksResponse,
  LinkIntelligenceGapResponse,
} from "@/modules/backlinks/dtos/link-intelligence.dto"

const CRAWL = "CC-MAIN-2026-30"
const REFERRING_DOMAINS = [
  {
    domain: "techcrunch.com",
    backlinkCount: 1240,
    firstSeenAt: "2024-01-15T00:00:00Z",
    lastSeenAt: "2026-08-30T00:00:00Z",
    category: "news",
  },
  {
    domain: "github.com",
    backlinkCount: 982,
    firstSeenAt: "2024-03-10T00:00:00Z",
    lastSeenAt: "2026-09-01T00:00:00Z",
    category: "dev",
  },
  {
    domain: "news.ycombinator.com",
    backlinkCount: 756,
    firstSeenAt: "2024-02-20T00:00:00Z",
    lastSeenAt: "2026-09-02T00:00:00Z",
    category: "community",
  },
  {
    domain: "moz.com",
    backlinkCount: 540,
    firstSeenAt: "2024-05-05T00:00:00Z",
    lastSeenAt: "2026-08-25T00:00:00Z",
    category: "seo",
  },
  {
    domain: "producthunt.com",
    backlinkCount: 423,
    firstSeenAt: "2024-06-12T00:00:00Z",
    lastSeenAt: "2026-08-28T00:00:00Z",
    category: "community",
  },
  {
    domain: "stackoverflow.com",
    backlinkCount: 388,
    firstSeenAt: "2024-04-01T00:00:00Z",
    lastSeenAt: "2026-08-31T00:00:00Z",
    category: "dev",
  },
]

const PAGES = [
  {
    url: "https://example.com/",
    backlinks: 8320,
    referringDomains: 1240,
    shareOfEquity: 42.5,
  },
  {
    url: "https://example.com/blog",
    backlinks: 4100,
    referringDomains: 680,
    shareOfEquity: 20.9,
  },
  {
    url: "https://example.com/pricing",
    backlinks: 1850,
    referringDomains: 320,
    shareOfEquity: 9.4,
  },
  {
    url: "https://example.com/docs",
    backlinks: 1420,
    referringDomains: 290,
    shareOfEquity: 7.3,
  },
  {
    url: "https://example.com/about",
    backlinks: 980,
    referringDomains: 180,
    shareOfEquity: 5.0,
  },
]

const ANCHORS = [
  { text: "Example", count: 2840, category: "branded" as const },
  { text: "SEO analytics", count: 1920, category: "topical" as const },
  { text: "backlink explorer", count: 1450, category: "topical" as const },
  { text: "example.com", count: 1100, category: "url" as const },
  { text: "read more", count: 980, category: "generic" as const },
]

const BROKEN = [
  {
    sourceUrl: "https://techcrunch.com/2025/05/old-review",
    targetUrl: "https://example.com/legacy-features",
    anchorText: "legacy features",
    status: "candidate" as const,
    firstSeenAt: "2025-05-10T00:00:00Z",
    lastSeenAt: "2026-08-01T00:00:00Z",
  },
  {
    sourceUrl: "https://moz.com/blog/outdated-roundup",
    targetUrl: "https://example.com/blog/deleted-post",
    anchorText: "outdated roundup",
    status: "candidate" as const,
    firstSeenAt: "2025-06-22T00:00:00Z",
    lastSeenAt: "2026-07-15T00:00:00Z",
  },
]

const GAP = [
  {
    domain: "ahrefs.com",
    linksToCompetitor: 142,
    linksToYou: 12,
    backlinkCount: 130,
  },
  {
    domain: "semrush.com",
    linksToCompetitor: 98,
    linksToYou: 8,
    backlinkCount: 90,
  },
  {
    domain: "seranking.com",
    linksToCompetitor: 64,
    linksToYou: 3,
    backlinkCount: 61,
  },
]

function now() {
  return new Date().toISOString()
}

export function mockSummary(domain: string): LinkIntelligenceSummaryResponse {
  return {
    domain,
    crawl: CRAWL,
    domainRating: 0,
    domainRatingStatus: "placeholder",
    referringDomains: REFERRING_DOMAINS.length,
    totalBacklinks: 19580,
    anchorPhrases: ANCHORS.length,
    topReferringDomains: REFERRING_DOMAINS.slice(0, 5),
    topAnchors: ANCHORS.slice(0, 5),
    generatedAt: now(),
  }
}

export function mockRating(domain: string): LinkIntelligenceRatingResponse {
  return {
    domain,
    crawl: CRAWL,
    domainRating: 0,
    domainRatingStatus: "placeholder",
    generatedAt: now(),
  }
}

export function mockReferringDomains(
  domain: string,
  page = 1,
  limit = 20,
): LinkIntelligenceReferringDomainsResponse {
  const total = REFERRING_DOMAINS.length
  const start = (page - 1) * limit
  const end = start + limit
  return {
    domain,
    crawl: CRAWL,
    referringDomains: REFERRING_DOMAINS.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < total,
      nextCursor: end < total ? String(page + 1) : undefined,
    },
    generatedAt: now(),
  }
}

export function mockTopPages(
  domain: string,
  page = 1,
  limit = 20,
): LinkIntelligenceTopPagesResponse {
  const total = PAGES.length
  const start = (page - 1) * limit
  const end = start + limit
  return {
    domain,
    crawl: CRAWL,
    pages: PAGES.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < total,
      nextCursor: end < total ? String(page + 1) : undefined,
    },
    generatedAt: now(),
  }
}

export function mockAnchors(
  domain: string,
  limit = 50,
): LinkIntelligenceAnchorsResponse {
  const terms = ANCHORS.slice(0, limit)
  const totalCount = terms.reduce((sum, t) => sum + t.count, 0)
  const buckets = { branded: 0, topical: 0, url: 0, generic: 0, other: 0 }
  for (const term of terms) {
    buckets[term.category] += term.count
  }
  return {
    domain,
    crawl: CRAWL,
    terms,
    distribution: (Object.keys(buckets) as Array<keyof typeof buckets>).map(
      (category) => ({
        category,
        count: buckets[category],
        percentage:
          totalCount > 0
            ? Number(((buckets[category] / totalCount) * 100).toFixed(1))
            : 0,
      }),
    ),
    generatedAt: now(),
  }
}

export function mockBrokenBacklinks(
  domain: string,
  page = 1,
  limit = 20,
): LinkIntelligenceBrokenBacklinksResponse {
  const total = BROKEN.length
  const start = (page - 1) * limit
  const end = start + limit
  return {
    domain,
    crawl: CRAWL,
    candidates: BROKEN.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < total,
      nextCursor: end < total ? String(page + 1) : undefined,
    },
    disclaimer:
      "These links are candidate broken backlinks. They have not been re-checked via HTTP and may already be fixed.",
    generatedAt: now(),
  }
}

export function mockGap(
  domain: string,
  competitor: string,
  page = 1,
  limit = 20,
): LinkIntelligenceGapResponse {
  const total = GAP.length
  const start = (page - 1) * limit
  const end = start + limit
  return {
    domain,
    competitor,
    crawl: CRAWL,
    uniqueToYou: 340,
    shared: 210,
    gapOpportunities: 1560,
    opportunities: GAP.slice(start, end),
    pagination: {
      page,
      limit,
      total,
      hasMore: end < total,
      nextCursor: end < total ? String(page + 1) : undefined,
    },
    generatedAt: now(),
  }
}
