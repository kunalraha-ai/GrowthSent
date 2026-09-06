import { type FormEvent, type ReactNode, useEffect, useState } from "react"

type LinkWorkspace = "explorer" | "rating" | "pages" | "anchors" | "broken" | "gap"

interface LinkIntelligenceViewProps {
  initialDomain?: string
}

const WORKSPACES: Array<{
  id: LinkWorkspace
  label: string
  eyebrow: string
  description: string
}> = [
  {
    id: "explorer",
    label: "Backlink Explorer",
    eyebrow: "OVERVIEW",
    description:
      "Inspect link equity, referring domains, and anchor coverage for one domain.",
  },
  {
    id: "rating",
    label: "Domain Rating",
    eyebrow: "AUTHORITY",
    description:
      "A link-graph authority score calculated from the processed backlink corpus.",
  },
  {
    id: "pages",
    label: "Top Linked Pages",
    eyebrow: "PAGES",
    description: "Discover the URLs attracting the most external link equity.",
  },
  {
    id: "anchors",
    label: "Anchor Text",
    eyebrow: "ANCHORS",
    description:
      "Understand the language other sites use when linking to a domain.",
  },
  {
    id: "broken",
    label: "Broken Backlinks",
    eyebrow: "OPPORTUNITIES",
    description: "Find inbound links whose target URL returns an error.",
  },
  {
    id: "gap",
    label: "Competitor Gap",
    eyebrow: "COMPETITION",
    description:
      "Compare two domains to identify referring domains you have not earned.",
  },
]

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M10.2 13.8a4 4 0 0 0 5.65.05l2.6-2.6a4 4 0 0 0-5.65-5.65l-1.48 1.47" />
      <path d="M13.8 10.2a4 4 0 0 0-5.65-.05l-2.6 2.6a4 4 0 0 0 5.65 5.65l1.47-1.47" />
    </svg>
  )
}

function GaugeIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 17a8 8 0 0 1 16 0" />
      <path d="m12 13 3.4-3.4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function PageIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}

function AnchorIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="6" r="3" />
      <path d="M12 9v11M5 13h14M7.5 20h9" />
    </svg>
  )
}

function BrokenIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="m9 3 6 18M5 6l2 2M17 16l2 2" />
      <path d="m7.5 14.5-2 2a3 3 0 0 0 4.24 4.24l2-2M16.5 9.5l2-2a3 3 0 0 0-4.24-4.24l-2 2" />
    </svg>
  )
}

function GapIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="7" cy="12" r="3" />
      <circle cx="17" cy="12" r="3" />
      <path d="M10 12h4" />
    </svg>
  )
}

function WorkspaceIcon({ workspace }: { workspace: LinkWorkspace }) {
  if (workspace === "rating") return <GaugeIcon />
  if (workspace === "pages") return <PageIcon />
  if (workspace === "anchors") return <AnchorIcon />
  if (workspace === "broken") return <BrokenIcon />
  if (workspace === "gap") return <GapIcon />
  return <LinkIcon />
}

function MetricPlaceholder({
  label,
  description,
}: {
  label: string
  description: string
}) {
  return (
    <div className="link-intelligence-metric">
      <p>{label}</p>
      <strong>—</strong>
      <span>{description}</span>
    </div>
  )
}

function EmptyDataState({
  title,
  description,
  icon = <LinkIcon />,
}: {
  title: string
  description: string
  icon?: ReactNode
}) {
  return (
    <div className="link-intelligence-empty-state">
      <div className="link-intelligence-empty-icon">{icon}</div>
      <h4>{title}</h4>
      <p>{description}</p>
      <span className="link-intelligence-pending-chip">
        Awaiting link-index connection
      </span>
    </div>
  )
}

function DomainContext({ domain }: { domain: string }) {
  return (
    <div className="link-intelligence-domain-context">
      <span>DOMAIN CONTEXT</span>
      <strong>{domain || "Choose a domain to explore"}</strong>
    </div>
  )
}

function ExplorerPanel({ domain }: { domain: string }) {
  return (
    <>
      <section
        className="link-intelligence-metric-grid"
        aria-label="Backlink explorer metrics"
      >
        <MetricPlaceholder
          label="Domain Rating"
          description="Graph authority score"
        />
        <MetricPlaceholder
          label="Referring domains"
          description="Unique external domains"
        />
        <MetricPlaceholder
          label="Total backlinks"
          description="External inbound links"
        />
        <MetricPlaceholder
          label="Anchor phrases"
          description="Distinct anchor text"
        />
      </section>
      <div className="link-intelligence-two-column">
        <section className="link-intelligence-card">
          <div className="link-intelligence-card-heading">
            <div>
              <p>REFERRING DOMAINS</p>
              <h4>Earned link sources</h4>
            </div>
            <span>Top domains</span>
          </div>
          <EmptyDataState
            title="No referring-domain rollup yet"
            description={
              domain
                ? `The link graph has not been connected for ${domain}.`
                : "Search a domain to prepare this report."
            }
          />
        </section>
        <section className="link-intelligence-card">
          <div className="link-intelligence-card-heading">
            <div>
              <p>ANCHOR MIX</p>
              <h4>How the web describes you</h4>
            </div>
            <span>Distribution</span>
          </div>
          <div className="link-intelligence-anchor-preview">
            <div className="link-intelligence-anchor-ring">
              <span>—</span>
              <small>phrases</small>
            </div>
            <div>
              <strong>Anchor text distribution will appear here.</strong>
              <p>
                Branded, topical, URL, and other anchor categories are
                calculated from the link graph.
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

function RatingPanel({ domain }: { domain: string }) {
  return (
    <section className="link-intelligence-rating-layout">
      <div className="link-intelligence-rating-card">
        <p>DOMAIN RATING</p>
        <div className="link-intelligence-rating-gauge">
          <div>
            <strong>—</strong>
            <span>/ 100</span>
          </div>
        </div>
        <h4>{domain || "Select a domain"}</h4>
        <span>Calculated from the processed link graph</span>
      </div>
      <div className="link-intelligence-card link-intelligence-rating-explainer">
        <div className="link-intelligence-card-heading">
          <div>
            <p>HOW IT WORKS</p>
            <h4>Authority without a black box</h4>
          </div>
        </div>
        <div className="link-intelligence-explainer-list">
          <div>
            <span>01</span>
            <p>
              Referring domains establish the breadth of a domain’s link
              profile.
            </p>
          </div>
          <div>
            <span>02</span>
            <p>
              Link quality and the authority of each referring domain shape
              score propagation.
            </p>
          </div>
          <div>
            <span>03</span>
            <p>
              Scores are recalculated as the link graph grows, so no value is
              shown until the index is connected.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function LinkedPagesPanel({ domain }: { domain: string }) {
  return (
    <section className="link-intelligence-card">
      <div className="link-intelligence-card-heading">
        <div>
          <p>TOP LINKED PAGES</p>
          <h4>Pages attracting external authority</h4>
          <span>
            Ranked by inbound backlink count and unique referring domains.
          </span>
        </div>
        <DomainContext domain={domain} />
      </div>
      <div className="link-intelligence-table-shell">
        <div className="link-intelligence-table-head">
          <span>Page</span>
          <span>Backlinks</span>
          <span>Referring domains</span>
          <span>Share of equity</span>
        </div>
        <EmptyDataState
          title="Page-level links are not connected yet"
          description="This table will rank URLs once the processed WAT link graph is available."
          icon={<PageIcon />}
        />
      </div>
    </section>
  )
}

function AnchorsPanel({ domain }: { domain: string }) {
  return (
    <div className="link-intelligence-two-column link-intelligence-anchor-layout">
      <section className="link-intelligence-card">
        <div className="link-intelligence-card-heading">
          <div>
            <p>ANCHOR TEXT CLOUD</p>
            <h4>Language around {domain || "this domain"}</h4>
          </div>
        </div>
        <EmptyDataState
          title="No anchor terms to display"
          description="Phrase size will represent relative backlink frequency, while colors will distinguish anchor categories."
          icon={<AnchorIcon />}
        />
      </section>
      <section className="link-intelligence-card">
        <div className="link-intelligence-card-heading">
          <div>
            <p>ANCHOR DISTRIBUTION</p>
            <h4>Profile balance</h4>
          </div>
        </div>
        <div className="link-intelligence-distribution-placeholder">
          {["Branded", "Topical", "URL", "Generic", "Other"].map((label) => (
            <div key={label}>
              <span>{label}</span>
              <i />
              <b>—</b>
            </div>
          ))}
        </div>
        <p className="link-intelligence-card-note">
          Percentages remain blank until link graph data is connected.
        </p>
      </section>
    </div>
  )
}

function BrokenPanel({
  domain,
  onDomainChange,
}: {
  domain: string
  onDomainChange: (value: string) => void
}) {
  return (
    <section className="link-intelligence-card link-intelligence-tool-card">
      <div className="link-intelligence-card-heading">
        <div>
          <p>BROKEN BACKLINKS FINDER</p>
          <h4>Recover lost link equity</h4>
          <span>
            Compare backlink targets against crawl and HTTP-status evidence.
          </span>
        </div>
        <div className="link-intelligence-tool-icon">
          <BrokenIcon />
        </div>
      </div>
      <label
        className="link-intelligence-input-label"
        htmlFor="broken-backlink-domain"
      >
        Domain to inspect
      </label>
      <div className="link-intelligence-input-row">
        <input
          id="broken-backlink-domain"
          value={domain}
          onChange={(event) => onDomainChange(event.target.value)}
          placeholder="yourdomain.com"
          inputMode="url"
        />
        <button
          type="button"
          disabled
          title="Available after the link index is connected"
        >
          Index required
        </button>
      </div>
      <EmptyDataState
        title="Broken-link checks will run once data is connected"
        description="Results will include the linking page, destination URL, observed status, and recovery opportunity."
        icon={<BrokenIcon />}
      />
    </section>
  )
}

function GapPanel({
  domain,
  competitor,
  onCompetitorChange,
}: {
  domain: string
  competitor: string
  onCompetitorChange: (value: string) => void
}) {
  return (
    <section className="link-intelligence-card link-intelligence-tool-card">
      <div className="link-intelligence-card-heading">
        <div>
          <p>COMPETITOR GAP ANALYSIS</p>
          <h4>Find domains linking to competitors, not you</h4>
          <span>
            Compare referring-domain sets without treating every backlink as
            equal.
          </span>
        </div>
        <div className="link-intelligence-tool-icon">
          <GapIcon />
        </div>
      </div>
      <div className="link-intelligence-gap-inputs">
        <label>
          <span>Your domain</span>
          <input value={domain} readOnly placeholder="yourdomain.com" />
        </label>
        <span className="link-intelligence-versus">VS</span>
        <label>
          <span>Competitor domain</span>
          <input
            value={competitor}
            onChange={(event) => onCompetitorChange(event.target.value)}
            placeholder="competitor.com"
            inputMode="url"
          />
        </label>
        <button
          type="button"
          disabled
          title="Available after the link index is connected"
        >
          Index required
        </button>
      </div>
      <div className="link-intelligence-gap-columns">
        <div>
          <p>UNIQUE TO YOU</p>
          <strong>—</strong>
          <span>Referring domains</span>
        </div>
        <div>
          <p>SHARED</p>
          <strong>—</strong>
          <span>Referring domains</span>
        </div>
        <div>
          <p>GAP OPPORTUNITIES</p>
          <strong>—</strong>
          <span>Referring domains</span>
        </div>
      </div>
      <EmptyDataState
        title="Comparison data is not available yet"
        description="Enter a competitor now; the comparison will become available when the link graph is connected."
        icon={<GapIcon />}
      />
    </section>
  )
}

export default function LinkIntelligenceView({
  initialDomain = "",
}: LinkIntelligenceViewProps) {
  const [activeWorkspace, setActiveWorkspace] =
    useState<LinkWorkspace>("explorer")
  const [domainInput, setDomainInput] = useState(initialDomain)
  const [selectedDomain, setSelectedDomain] = useState(initialDomain)
  const [competitor, setCompetitor] = useState("")

  useEffect(() => {
    if (!domainInput && initialDomain) {
      setDomainInput(initialDomain)
      setSelectedDomain(initialDomain)
    }
  }, [domainInput, initialDomain])

  const activeMeta =
    WORKSPACES.find((workspace) => workspace.id === activeWorkspace) ??
    WORKSPACES[0]
  const domain = selectedDomain.trim()

  const submitDomain = (event: FormEvent) => {
    event.preventDefault()
    setSelectedDomain(domainInput.trim())
  }

  const renderWorkspace = () => {
    if (activeWorkspace === "rating") return <RatingPanel domain={domain} />
    if (activeWorkspace === "pages") return <LinkedPagesPanel domain={domain} />
    if (activeWorkspace === "anchors") return <AnchorsPanel domain={domain} />
    if (activeWorkspace === "broken")
      return (
        <BrokenPanel domain={domainInput} onDomainChange={setDomainInput} />
      )
    if (activeWorkspace === "gap")
      return (
        <GapPanel
          domain={domainInput}
          competitor={competitor}
          onCompetitorChange={setCompetitor}
        />
      )
    return <ExplorerPanel domain={domain} />
  }

  return (
    <section className="link-intelligence-view">
      <div className="console-title link-intelligence-title">
        <div>
          <p>LINK INTELLIGENCE</p>
          <h3>Understand your place in the web’s link graph</h3>
        </div>
        <span className="link-intelligence-status">
          <i /> Link index preparing
        </span>
      </div>

      <form className="link-intelligence-search" onSubmit={submitDomain}>
        <div className="link-intelligence-search-icon">
          <SearchIcon />
        </div>
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
      <p className="link-intelligence-connection-note">
        The interface is ready. Metrics and tables will populate from the
        processed Common Crawl link graph once its data connection is enabled.
      </p>

      <div className="link-intelligence-layout">
        <nav
          className="link-intelligence-nav"
          aria-label="Link intelligence tools"
        >
          {WORKSPACES.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={activeWorkspace === workspace.id ? "is-active" : ""}
              onClick={() => setActiveWorkspace(workspace.id)}
            >
              <WorkspaceIcon workspace={workspace.id} />
              <span>{workspace.label}</span>
            </button>
          ))}
        </nav>
        <div className="link-intelligence-content">
          <header className="link-intelligence-workspace-heading">
            <div>
              <p>{activeMeta.eyebrow}</p>
              <h4>{activeMeta.label}</h4>
              <span>{activeMeta.description}</span>
            </div>
            <DomainContext domain={domain} />
          </header>
          {renderWorkspace()}
        </div>
      </div>
    </section>
  )
}
