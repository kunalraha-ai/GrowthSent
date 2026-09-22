export type LinkIntelligenceCrawl = "CC-MAIN-2026-30"

export interface LinkIntelligencePagination {
  page: number
  limit: number
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface ReferringDomain {
  domain: string
  backlinkCount: number
  firstSeenAt: string
  lastSeenAt: string
  category?: string
}

export interface TopLinkedPage {
  url: string
  backlinks: number
  referringDomains: number
  shareOfEquity: number
}

export type AnchorCategory = "branded" | "topical" | "url" | "generic" | "other"

export interface AnchorTerm {
  text: string
  count: number
  category: AnchorCategory
}

export interface AnchorDistribution {
  category: AnchorCategory
  count: number
  percentage: number
}

export interface BrokenBacklinkCandidate {
  sourceUrl: string
  targetUrl: string
  anchorText?: string
  status: "candidate" | "verified_broken" | "verified_live"
  statusCode?: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface CompetitorGapDomain {
  domain: string
  linksToCompetitor: number
  linksToYou: number
  backlinkCount: number
}

export interface LinkIntelligenceSummaryResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  domainRating: number
  domainRatingStatus: "placeholder"
  referringDomains: number
  totalBacklinks: number
  anchorPhrases: number
  topReferringDomains: ReferringDomain[]
  topAnchors: AnchorTerm[]
  generatedAt: string
}

export interface LinkIntelligenceRatingResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  domainRating: number
  domainRatingStatus: "placeholder"
  percentile?: number
  generatedAt: string
}

export interface LinkIntelligenceReferringDomainsResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  referringDomains: ReferringDomain[]
  pagination: LinkIntelligencePagination
  generatedAt: string
}

export interface LinkIntelligenceTopPagesResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  pages: TopLinkedPage[]
  pagination: LinkIntelligencePagination
  generatedAt: string
}

export interface LinkIntelligenceAnchorsResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  terms: AnchorTerm[]
  distribution: AnchorDistribution[]
  generatedAt: string
}

export interface LinkIntelligenceBrokenBacklinksResponse {
  domain: string
  crawl: LinkIntelligenceCrawl
  candidates: BrokenBacklinkCandidate[]
  pagination: LinkIntelligencePagination
  disclaimer: string
  generatedAt: string
}

export interface LinkIntelligenceGapResponse {
  domain: string
  competitor: string
  crawl: LinkIntelligenceCrawl
  uniqueToYou: number
  shared: number
  gapOpportunities: number
  opportunities: CompetitorGapDomain[]
  pagination: LinkIntelligencePagination
  generatedAt: string
}
