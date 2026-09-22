import { type FormEvent, useCallback, useEffect, useState } from "react"

import {
  getLinkIntelligenceSummary,
  getLinkIntelligenceRating,
  getLinkIntelligenceReferringDomains,
  getLinkIntelligenceTopPages,
  getLinkIntelligenceAnchors,
  getLinkIntelligenceBrokenBacklinks,
  getLinkIntelligenceGap,
  LinkIntelligenceApiError,
} from "@/lib/api/linkIntelligence"
import type {
  LinkIntelligenceSummaryResponse,
  LinkIntelligenceRatingResponse,
  LinkIntelligenceReferringDomainsResponse,
  LinkIntelligenceTopPagesResponse,
  LinkIntelligenceAnchorsResponse,
  LinkIntelligenceBrokenBacklinksResponse,
  LinkIntelligenceGapResponse,
  AnchorDistribution,
} from "@/modules/backlinks/dtos/link-intelligence.dto"

type Workspace = "explorer" | "rating" | "pages" | "anchors" | "broken" | "gap"

interface LinkIntelligenceViewProps {
  initialDomain?: string
}

const WORKSPACES: Array<{
  id: Workspace
  label: string
  description: string
}> = [
  {
    id: "explorer",
    label: "Backlink Explorer",
    description:
      "Inspect link equity, referring domains, and anchor coverage for one domain.",
  },
  {
    id: "rating",
    label: "Domain Rating",
    description:
      "A link-graph authority score calculated from the processed backlink corpus.",
  },
  {
    id: "pages",
    label: "Top Linked Pages",
    description:
      "Discover the URLs attracting the most external link equity, ranked by inbound backlinks and unique referring domains.",
  },
  {
    id: "anchors",
    label: "Anchor Text",
    description:
      "Understand the language other sites use when linking to this domain.",
  },
  {
    id: "broken",
    label: "Broken Backlinks",
    description:
      "Find inbound links whose target URL returns an error, so that equity can be recovered.",
  },
  {
    id: "gap",
    label: "Competitor Gap",
    description:
      "Compare two domains to find referring domains you have not earned.",
  },
]

function formatNumber(value: number): string {
  return value.toLocaleString()
}

function useLinkIntelligenceQuery<T>(
  fetcher: () => Promise<T>,
  enabled: boolean,
): {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    setError(null)
    let cancelled = false
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message =
          err instanceof LinkIntelligenceApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load data"
        setError(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetcher, enabled])

  useEffect(() => {
    const cleanup = fetchData()
    return cleanup
  }, [fetchData])

  return { data, loading, error, refetch: fetchData }
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" strokeLinecap="round" />
    </svg>
  )
}

function ToolIcon({ tool }: { tool: Workspace }) {
  if (tool === "rating") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M4 19V9M12 19V5M20 19v-7" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "pages") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M9 12h6M9 16h6" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "anchors") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v9M6 14a6 6 0 0 0 12 0" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "broken") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="m9 6 6 12M15 6 9 18" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "gap") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="7" cy="12" r="4" />
        <circle cx="17" cy="12" r="4" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"
        strokeLinecap="round"
      />
      <path
        d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function EmptyState({
  tool,
  title,
  description,
  action = true,
}: {
  tool: Workspace
  title: string
  description: string
  action?: boolean
}) {
  return (
    <div className="li-empty-state">
      <div className="li-empty-icon">
        <ToolIcon tool={tool} />
      </div>
      <h4>{title}</h4>
      <p>{description}</p>
      {action && (
        <button type="button" className="li-ghost-button" disabled>
          Index preparing
        </button>
      )}
    </div>
  )
}

function MetricCard({
  label,
  help,
  value,
}: {
  label: string
  help: string
  value?: React.ReactNode
}) {
  return (
    <article className="li-metric-card">
      <p>{label}</p>
      <strong>{value ?? "—"}</strong>
      <span>{help}</span>
      <svg
        aria-hidden="true"
        className="li-flatline"
        viewBox="0 0 54 20"
        fill="none"
      >
        <path
          d="M0 14h54"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="3 4"
          strokeLinecap="round"
        />
      </svg>
    </article>
  )
}

function PanelHeader({ workspace }: { workspace: Workspace }) {
  const active =
    WORKSPACES.find((item) => item.id === workspace) ?? WORKSPACES[0]
  return (
    <header className="li-panel-header">
      <h2>{active.label}</h2>
      <p>{active.description}</p>
    </header>
  )
}

function ExplorerPanel({
  domain,
  summary,
  loading,
  error,
}: {
  domain: string
  summary: LinkIntelligenceSummaryResponse | null
  loading: boolean
  error: string | null
}) {
  const domainLabel = domain || "this domain"
  const hasData = Boolean(summary && !loading && !error)

  return (
    <>
      <section className="li-metric-grid" aria-label="Backlink metrics">
        <MetricCard
          label="Domain rating"
          help="Graph authority score"
          value={summary?.domainRating ?? "—"}
        />
        <MetricCard
          label="Referring domains"
          help="Unique external domains"
          value={summary ? formatNumber(summary.referringDomains) : "—"}
        />
        <MetricCard
          label="Total backlinks"
          help="External inbound links"
          value={summary ? formatNumber(summary.totalBacklinks) : "—"}
        />
        <MetricCard
          label="Anchor phrases"
          help="Distinct anchor text"
          value={summary ? formatNumber(summary.anchorPhrases) : "—"}
        />
      </section>
      <section className="li-card-grid">
        <article className="li-info-card">
          <h3>Earned link sources</h3>
          <p className="li-info-sub">
            The domains sending this site the most link equity.
          </p>
          {loading && (
            <EmptyState
              tool="explorer"
              title="Loading referring domains"
              description="Fetching the latest link data."
              action={false}
            />
          )}
          {error && (
            <EmptyState
              tool="explorer"
              title="Could not load data"
              description={error}
              action={false}
            />
          )}
          {!loading && !error && !hasData && (
            <EmptyState
              tool="explorer"
              title="No referring domains yet"
              description={`This list fills in once the link index connects for ${domainLabel}.`}
            />
          )}
          {hasData && summary && (
            <div className="li-list">
              {summary.topReferringDomains.map((item) => (
                <div key={item.domain} className="li-list-row">
                  <div>
                    <h4>{item.domain}</h4>
                    <p>
                      {item.category ? `${item.category} · ` : ""}
                      {formatNumber(item.backlinkCount)} backlinks
                    </p>
                  </div>
                  <span>{formatNumber(item.backlinkCount)}</span>
                </div>
              ))}
            </div>
          )}
        </article>
        <article className="li-info-card">
          <h3>How the web describes you</h3>
          <p className="li-info-sub">
            The anchor text other sites use when linking here.
          </p>
          {loading && (
            <EmptyState
              tool="anchors"
              title="Loading anchor phrases"
              description="Fetching anchor text distribution."
              action={false}
            />
          )}
          {error && (
            <EmptyState
              tool="anchors"
              title="Could not load data"
              description={error}
              action={false}
            />
          )}
          {!loading && !error && !hasData && (
            <EmptyState
              tool="anchors"
              title="No anchor phrases yet"
              description="Phrase size will reflect backlink frequency once the index is connected."
            />
          )}
          {hasData && summary && (
            <div className="li-list">
              {summary.topAnchors.map((item) => (
                <div key={item.text} className="li-list-row">
                  <div>
                    <h4>"{item.text}"</h4>
                    <p style={{ textTransform: "capitalize" }}>
                      {item.category}
                    </p>
                  </div>
                  <span>{formatNumber(item.count)}</span>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </>
  )
}

function RatingPanel({
  domain,
  data,
  loading,
  error,
}: {
  domain: string
  data: LinkIntelligenceRatingResponse | null
  loading: boolean
  error: string | null
}) {
  const isPlaceholder = data?.domainRatingStatus === "placeholder"
  return (
    <section className="li-card-grid">
      <article className="li-rating-card">
        <p>Domain rating</p>
        <svg
          aria-label="Domain Rating"
          className="li-rating-gauge"
          viewBox="0 0 140 140"
        >
          <circle
            cx="70"
            cy="70"
            r="58"
            fill="none"
            stroke="rgba(18,22,11,.15)"
            strokeWidth="10"
          />
          <circle
            cx="70"
            cy="70"
            r="58"
            fill="none"
            stroke="#12160B"
            strokeWidth="10"
            strokeDasharray="20 4"
            strokeLinecap="round"
            transform="rotate(-90 70 70)"
          />
          <text x="70" y="66" textAnchor="middle">
            {loading ? "…" : data ? data.domainRating : "—"}
          </text>
          <text className="li-rating-out-of" x="70" y="86" textAnchor="middle">
            / 100
          </text>
        </svg>
        <strong>{domain || "Select a domain"}</strong>
        <span>
          {isPlaceholder
            ? "A real graph score is calculated after the PageRank enrichment stage."
            : "Calculated from the processed link graph"}
        </span>
      </article>
      <article className="li-info-card li-rating-explainer">
        <h3>How a score is built</h3>
        <p className="li-info-sub">Authority without a black box.</p>
        <ol className="li-step-list">
          <li>
            <span>1</span>
            <div>
              <h4>Discover referring domains</h4>
              <p>
                Every unique domain linking here establishes the breadth of the
                link profile.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <h4>Weight by link quality</h4>
              <p>
                Each referring domain’s authority shapes how much equity it
                passes on.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <h4>Recalculate as the graph grows</h4>
              <p>Scores update automatically when the index is ready.</p>
            </div>
          </li>
        </ol>
        {error && (
          <p className="li-card-note" style={{ color: "#b91c1c" }}>
            {error}
          </p>
        )}
      </article>
    </section>
  )
}

function PagesPanel({
  data,
  loading,
  error,
}: {
  data: LinkIntelligenceTopPagesResponse | null
  loading: boolean
  error: string | null
}) {
  return (
    <section className="li-table-card">
      <div className="li-table-header">
        <span>Page</span>
        <span>Backlinks</span>
        <span>Referring domains</span>
        <span>Share of equity</span>
      </div>
      {loading && (
        <EmptyState
          tool="pages"
          title="Loading top pages"
          description="Fetching page-level link data."
          action={false}
        />
      )}
      {error && (
        <EmptyState
          tool="pages"
          title="Could not load data"
          description={error}
          action={false}
        />
      )}
      {!loading && !error && data && data.pages.length === 0 && (
        <EmptyState
          tool="pages"
          title="Page-level links are not connected yet"
          description="This table ranks URLs as soon as the processed WAT link graph is available."
        />
      )}
      {data && data.pages.length > 0 && (
        <div>
          {data.pages.map((page) => (
            <div key={page.url} className="li-table-row">
              <a href={page.url} target="_blank" rel="noopener noreferrer">
                {page.url}
              </a>
              <span>{formatNumber(page.backlinks)}</span>
              <span>{formatNumber(page.referringDomains)}</span>
              <span>{page.shareOfEquity}%</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function AnchorsPanel({
  domain,
  data,
  loading,
  error,
}: {
  domain: string
  data: LinkIntelligenceAnchorsResponse | null
  loading: boolean
  error: string | null
}) {
  const maxCount =
    data && data.terms.length > 0
      ? Math.max(...data.terms.map((t) => t.count))
      : 0
  return (
    <section className="li-card-grid">
      <article className="li-info-card">
        <h3>Language around {domain || "this domain"}</h3>
        <p className="li-info-sub">
          Phrase size reflects backlink frequency; color marks the anchor
          category.
        </p>
        {loading && (
          <EmptyState
            tool="anchors"
            title="Loading anchor phrases"
            description="Fetching anchor text distribution."
            action={false}
          />
        )}
        {error && (
          <EmptyState
            tool="anchors"
            title="Could not load data"
            description={error}
            action={false}
          />
        )}
        {!loading && !error && data && data.terms.length === 0 && (
          <EmptyState
            tool="anchors"
            title="No anchor terms to display"
            description="Terms appear here once the link index is connected."
          />
        )}
        {data && data.terms.length > 0 && (
          <div className="li-list">
            {data.terms.map((term) => (
              <div key={term.text} className="li-list-row">
                <div>
                  <h4>"{term.text}"</h4>
                  <p style={{ textTransform: "capitalize" }}>{term.category}</p>
                </div>
                <div style={{ display: "grid", gap: 6, minWidth: 80 }}>
                  <span
                    className="li-bar"
                    title={`${formatNumber(term.count)} backlinks`}
                  >
                    <i
                      style={{
                        width:
                          maxCount > 0
                            ? `${(term.count / maxCount) * 100}%`
                            : "0%",
                      }}
                    />
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#9ba08d",
                      textAlign: "right",
                    }}
                  >
                    {formatNumber(term.count)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
      <article className="li-info-card">
        <h3>Profile balance</h3>
        <p className="li-info-sub">How anchor text splits across categories.</p>
        {!loading && !error && data && data.distribution.length > 0 && (
          <div className="li-anchor-list">
            {data.distribution.map((item) => (
              <AnchorDistributionRow key={item.category} item={item} />
            ))}
          </div>
        )}
        {data && data.distribution.length > 0 && (
          <p className="li-card-note">
            Percentages are computed from the sampled anchor set.
          </p>
        )}
      </article>
    </section>
  )
}

function AnchorDistributionRow({ item }: { item: AnchorDistribution }) {
  const max = Math.max(item.percentage, 100)
  return (
    <div>
      <span style={{ textTransform: "capitalize" }}>{item.category}</span>
      <i>
        <b
          style={{
            display: "block",
            height: "100%",
            width: `${(item.percentage / max) * 100}%`,
            background: "#1e6b32",
            borderRadius: 6,
          }}
        />
      </i>
      <b>{item.percentage}%</b>
    </div>
  )
}

function BrokenPanel({
  domain,
  data,
  loading,
  error,
}: {
  domain: string
  data: LinkIntelligenceBrokenBacklinksResponse | null
  loading: boolean
  error: string | null
}) {
  return (
    <section className="li-info-card li-tool-card">
      <h3>Recover lost link equity</h3>
      <p className="li-info-sub">
        Compares backlink targets against crawl and HTTP-status evidence.
      </p>
      <div className="li-input-row">
        <input
          value={domain}
          readOnly
          placeholder="yourdomain.com"
          aria-label="Domain to inspect"
        />
        <button type="button" className="li-ghost-button" disabled={loading}>
          {loading ? "Checking…" : "Index ready"}
        </button>
      </div>
      {loading && (
        <EmptyState
          tool="broken"
          title="Loading broken-link candidates"
          description="Fetching candidate broken backlinks."
          action={false}
        />
      )}
      {error && (
        <EmptyState
          tool="broken"
          title="Could not load data"
          description={error}
          action={false}
        />
      )}
      {!loading && !error && data && data.candidates.length === 0 && (
        <EmptyState
          tool="broken"
          title="No broken-link candidates found"
          description="Results will include the linking page, destination URL, observed status, and recovery opportunity."
          action={false}
        />
      )}
      {data && data.candidates.length > 0 && (
        <>
          <div
            className="li-table-header"
            style={{ gridTemplateColumns: "2fr 2fr 0.8fr 1fr" }}
          >
            <span>Linking page</span>
            <span>Destination URL</span>
            <span>Status</span>
            <span>Opportunity</span>
          </div>
          <div>
            {data.candidates.map((candidate, index) => (
              <div
                key={`${candidate.sourceUrl}-${candidate.targetUrl}-${index}`}
                className="li-table-row"
                style={{ gridTemplateColumns: "2fr 2fr 0.8fr 1fr" }}
              >
                <a
                  href={candidate.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {candidate.sourceUrl}
                </a>
                <a
                  href={candidate.targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {candidate.targetUrl}
                </a>
                <span style={{ textTransform: "capitalize" }}>
                  {candidate.status.replace("_", " ")}
                </span>
                <span>{candidate.anchorText || "—"}</span>
              </div>
            ))}
          </div>
          <p className="li-disclaimer">{data.disclaimer}</p>
        </>
      )}
      <div className="li-tag-row" aria-label="Future broken backlink fields">
        {["Linking page", "Destination URL", "Status", "Opportunity"].map(
          (tag) => (
            <span key={tag}>{tag}</span>
          ),
        )}
      </div>
    </section>
  )
}

function GapPanel({
  domain,
  competitor,
  onCompetitorChange,
  data,
  loading,
  error,
}: {
  domain: string
  competitor: string
  onCompetitorChange: (value: string) => void
  data: LinkIntelligenceGapResponse | null
  loading: boolean
  error: string | null
}) {
  return (
    <section className="li-info-card li-tool-card">
      <h3>Find domains linking to competitors, not you</h3>
      <p className="li-info-sub">
        Compares referring-domain sets without treating every backlink as equal.
      </p>
      <div className="li-input-row li-gap-input-row">
        <input
          value={domain}
          readOnly
          placeholder="yourdomain.com"
          aria-label="Your domain"
        />
        <span>vs</span>
        <input
          value={competitor}
          onChange={(event) => onCompetitorChange(event.target.value)}
          placeholder="competitor.com"
          aria-label="Competitor domain"
          inputMode="url"
        />
        <button
          type="button"
          className="li-ghost-button"
          disabled={!competitor || loading}
        >
          {loading ? "Comparing…" : "Compare"}
        </button>
      </div>
      <div className="li-gap-metrics">
        <MetricCard
          label="Unique to you"
          help="Referring domains"
          value={data ? formatNumber(data.uniqueToYou) : "—"}
        />
        <MetricCard
          label="Shared"
          help="Referring domains"
          value={data ? formatNumber(data.shared) : "—"}
        />
        <MetricCard
          label="Gap opportunities"
          help="Referring domains"
          value={data ? formatNumber(data.gapOpportunities) : "—"}
        />
      </div>
      {loading && (
        <EmptyState
          tool="gap"
          title="Loading competitor comparison"
          description="Fetching gap opportunities."
          action={false}
        />
      )}
      {error && (
        <EmptyState
          tool="gap"
          title="Could not load data"
          description={error}
          action={false}
        />
      )}
      {!loading && !error && data && data.opportunities.length === 0 && (
        <EmptyState
          tool="gap"
          title="Comparison data is not available yet"
          description="Enter a competitor domain — the comparison activates once the link index connects."
          action={false}
        />
      )}
      {data && data.opportunities.length > 0 && (
        <>
          <div
            className="li-table-header"
            style={{ marginTop: 18, gridTemplateColumns: "2.4fr 1fr 1fr 1fr" }}
          >
            <span>Domain</span>
            <span>Links to competitor</span>
            <span>Links to you</span>
            <span>Gap</span>
          </div>
          <div>
            {data.opportunities.map((item) => (
              <div
                key={item.domain}
                className="li-table-row"
                style={{ gridTemplateColumns: "2.4fr 1fr 1fr 1fr" }}
              >
                <span>{item.domain}</span>
                <span>{formatNumber(item.linksToCompetitor)}</span>
                <span>{formatNumber(item.linksToYou)}</span>
                <span>{formatNumber(item.backlinkCount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

export default function LinkIntelligenceView({
  initialDomain = "",
}: LinkIntelligenceViewProps) {
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>("explorer")
  const [domainInput, setDomainInput] = useState(initialDomain)
  const [domain, setDomain] = useState(initialDomain)
  const [competitor, setCompetitor] = useState("")

  useEffect(() => {
    if (initialDomain && !domainInput) {
      setDomainInput(initialDomain)
      setDomain(initialDomain)
    }
  }, [domainInput, initialDomain])

  const submitDomain = (event: FormEvent) => {
    event.preventDefault()
    setDomain(domainInput.trim())
  }

  const summaryQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceSummary(domain), [domain]),
    Boolean(domain),
  )

  const ratingQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceRating(domain), [domain]),
    Boolean(domain) && activeWorkspace === "rating",
  )

  const referringDomainsQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceReferringDomains(domain), [domain]),
    Boolean(domain) && activeWorkspace === "explorer",
  )

  const topPagesQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceTopPages(domain), [domain]),
    Boolean(domain) && activeWorkspace === "pages",
  )

  const anchorsQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceAnchors(domain), [domain]),
    Boolean(domain) && activeWorkspace === "anchors",
  )

  const brokenQuery = useLinkIntelligenceQuery(
    useCallback(() => getLinkIntelligenceBrokenBacklinks(domain), [domain]),
    Boolean(domain) && activeWorkspace === "broken",
  )

  const gapQuery = useLinkIntelligenceQuery(
    useCallback(
      () => getLinkIntelligenceGap(domain, competitor),
      [domain, competitor],
    ),
    Boolean(domain) && Boolean(competitor) && activeWorkspace === "gap",
  )

  const renderPanel = () => {
    if (activeWorkspace === "rating")
      return (
        <RatingPanel
          domain={domain}
          data={ratingQuery.data}
          loading={ratingQuery.loading}
          error={ratingQuery.error}
        />
      )
    if (activeWorkspace === "pages")
      return (
        <PagesPanel
          data={topPagesQuery.data}
          loading={topPagesQuery.loading}
          error={topPagesQuery.error}
        />
      )
    if (activeWorkspace === "anchors")
      return (
        <AnchorsPanel
          domain={domain}
          data={anchorsQuery.data}
          loading={anchorsQuery.loading}
          error={anchorsQuery.error}
        />
      )
    if (activeWorkspace === "broken")
      return (
        <BrokenPanel
          domain={domain}
          data={brokenQuery.data}
          loading={brokenQuery.loading}
          error={brokenQuery.error}
        />
      )
    if (activeWorkspace === "gap")
      return (
        <GapPanel
          domain={domain}
          competitor={competitor}
          onCompetitorChange={setCompetitor}
          data={gapQuery.data}
          loading={gapQuery.loading}
          error={gapQuery.error}
        />
      )
    return (
      <ExplorerPanel
        domain={domain}
        summary={summaryQuery.data}
        loading={summaryQuery.loading}
        error={summaryQuery.error}
      />
    )
  }

  return (
    <section className="link-intelligence-view li-workbench">
      <header className="li-top-row">
        <div>
          <h1>Understand your place in the web’s link graph</h1>
          <p>
            Every tool below reads from the same processed Common Crawl link
            index for the domain above.
          </p>
        </div>
        <span className="li-status">
          <i />
          Link index active
        </span>
      </header>

      <form className="li-search-bar" onSubmit={submitDomain}>
        <SearchIcon />
        <label htmlFor="link-intelligence-domain">Explore a domain</label>
        <input
          id="link-intelligence-domain"
          value={domainInput}
          onChange={(event) => setDomainInput(event.target.value)}
          placeholder="yourdomain.com"
          autoComplete="url"
          inputMode="url"
        />
        <button type="submit">Open workspace</button>
      </form>
      <p className="li-helper-line">
        Scores and tables activate automatically once the link index finishes
        processing — nothing to configure.
      </p>

      <div className="li-content-layout">
        <nav className="li-subnav" aria-label="Link intelligence tools">
          {WORKSPACES.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={activeWorkspace === workspace.id ? "is-active" : ""}
              onClick={() => setActiveWorkspace(workspace.id)}
            >
              <ToolIcon tool={workspace.id} />
              <span>{workspace.label}</span>
            </button>
          ))}
        </nav>
        <main className="li-panels">
          <PanelHeader workspace={activeWorkspace} />
          {renderPanel()}
        </main>
      </div>
    </section>
  )
}
