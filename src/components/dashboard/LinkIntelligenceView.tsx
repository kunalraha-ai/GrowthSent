import { type FormEvent, useEffect, useState } from "react"

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
    description: "Understand the language other sites use when linking to this domain.",
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
    description: "Compare two domains to find referring domains you have not earned.",
  },
]

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
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 19V9M12 19V5M20 19v-7" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "pages") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M9 12h6M9 16h6" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "anchors") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v9M6 14a6 6 0 0 0 12 0" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "broken") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m9 6 6 12M15 6 9 18" strokeLinecap="round" />
      </svg>
    )
  }
  if (tool === "gap") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="7" cy="12" r="4" />
        <circle cx="17" cy="12" r="4" />
      </svg>
    )
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" strokeLinecap="round" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" strokeLinecap="round" />
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

function MetricCard({ label, help }: { label: string; help: string }) {
  return (
    <article className="li-metric-card">
      <p>{label}</p>
      <strong>—</strong>
      <span>{help}</span>
      <svg aria-hidden="true" className="li-flatline" viewBox="0 0 54 20" fill="none">
        <path d="M0 14h54" stroke="currentColor" strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" />
      </svg>
    </article>
  )
}

function PanelHeader({ workspace }: { workspace: Workspace }) {
  const active = WORKSPACES.find((item) => item.id === workspace) ?? WORKSPACES[0]
  return (
    <header className="li-panel-header">
      <h2>{active.label}</h2>
      <p>{active.description}</p>
    </header>
  )
}

function ExplorerPanel({ domain }: { domain: string }) {
  const domainLabel = domain || "this domain"
  return (
    <>
      <section className="li-metric-grid" aria-label="Backlink metrics">
        <MetricCard label="Domain rating" help="Graph authority score" />
        <MetricCard label="Referring domains" help="Unique external domains" />
        <MetricCard label="Total backlinks" help="External inbound links" />
        <MetricCard label="Anchor phrases" help="Distinct anchor text" />
      </section>
      <section className="li-card-grid">
        <article className="li-info-card">
          <h3>Earned link sources</h3>
          <p className="li-info-sub">The domains sending this site the most link equity.</p>
          <EmptyState
            tool="explorer"
            title="No referring domains yet"
            description={`This list fills in once the link index connects for ${domainLabel}.`}
          />
        </article>
        <article className="li-info-card">
          <h3>How the web describes you</h3>
          <p className="li-info-sub">The anchor text other sites use when linking here.</p>
          <EmptyState
            tool="anchors"
            title="No anchor phrases yet"
            description="Phrase size will reflect backlink frequency once the index is connected."
          />
        </article>
      </section>
    </>
  )
}

function RatingPanel({ domain }: { domain: string }) {
  return (
    <section className="li-card-grid">
      <article className="li-rating-card">
        <p>Domain rating</p>
        <svg aria-label="Domain Rating pending" className="li-rating-gauge" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(18,22,11,.15)" strokeWidth="10" />
          <circle cx="70" cy="70" r="58" fill="none" stroke="#12160B" strokeWidth="10" strokeDasharray="20 4" strokeLinecap="round" transform="rotate(-90 70 70)" />
          <text x="70" y="66" textAnchor="middle">—</text>
          <text className="li-rating-out-of" x="70" y="86" textAnchor="middle">/ 100</text>
        </svg>
        <strong>{domain || "Select a domain"}</strong>
        <span>Calculated from the processed link graph</span>
      </article>
      <article className="li-info-card li-rating-explainer">
        <h3>How a score is built</h3>
        <p className="li-info-sub">Authority without a black box.</p>
        <ol className="li-step-list">
          <li>
            <span>1</span>
            <div>
              <h4>Discover referring domains</h4>
              <p>Every unique domain linking here establishes the breadth of the link profile.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <h4>Weight by link quality</h4>
              <p>Each referring domain’s authority shapes how much equity it passes on.</p>
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
      </article>
    </section>
  )
}

function PagesPanel() {
  return (
    <section className="li-table-card">
      <div className="li-table-header">
        <span>Page</span>
        <span>Backlinks</span>
        <span>Referring domains</span>
        <span>Share of equity</span>
      </div>
      <EmptyState
        tool="pages"
        title="Page-level links are not connected yet"
        description="This table ranks URLs as soon as the processed WAT link graph is available."
      />
    </section>
  )
}

function AnchorsPanel({ domain }: { domain: string }) {
  return (
    <section className="li-card-grid">
      <article className="li-info-card">
        <h3>Language around {domain || "this domain"}</h3>
        <p className="li-info-sub">Phrase size reflects backlink frequency; color marks the anchor category.</p>
        <EmptyState tool="anchors" title="No anchor terms to display" description="Terms appear here once the link index is connected." />
      </article>
      <article className="li-info-card">
        <h3>Profile balance</h3>
        <p className="li-info-sub">How anchor text splits across categories.</p>
        <div className="li-anchor-list">
          {["Branded", "Topical", "URL", "Generic", "Other"].map((label) => (
            <div key={label}>
              <span>{label}</span>
              <i aria-hidden="true" />
              <b>—</b>
            </div>
          ))}
        </div>
        <p className="li-card-note">Percentages fill in once link graph data is connected.</p>
      </article>
    </section>
  )
}

function BrokenPanel({ domain }: { domain: string }) {
  return (
    <section className="li-info-card li-tool-card">
      <h3>Recover lost link equity</h3>
      <p className="li-info-sub">Compares backlink targets against crawl and HTTP-status evidence.</p>
      <div className="li-input-row">
        <input value={domain} readOnly placeholder="yourdomain.com" aria-label="Domain to inspect" />
        <button type="button" className="li-ghost-button" disabled>Index required</button>
      </div>
      <EmptyState
        tool="broken"
        title="Broken-link checks run once data is connected"
        description="Results will include the linking page, destination URL, observed status, and recovery opportunity."
        action={false}
      />
      <div className="li-tag-row" aria-label="Future broken backlink fields">
        {['Linking page', 'Destination URL', 'Status', 'Opportunity'].map((tag) => <span key={tag}>{tag}</span>)}
      </div>
    </section>
  )
}

function GapPanel({ domain, competitor, onCompetitorChange }: { domain: string; competitor: string; onCompetitorChange: (value: string) => void }) {
  return (
    <section className="li-info-card li-tool-card">
      <h3>Find domains linking to competitors, not you</h3>
      <p className="li-info-sub">Compares referring-domain sets without treating every backlink as equal.</p>
      <div className="li-input-row li-gap-input-row">
        <input value={domain} readOnly placeholder="yourdomain.com" aria-label="Your domain" />
        <span>vs</span>
        <input value={competitor} onChange={(event) => onCompetitorChange(event.target.value)} placeholder="competitor.com" aria-label="Competitor domain" inputMode="url" />
        <button type="button" className="li-ghost-button" disabled>Index required</button>
      </div>
      <div className="li-gap-metrics">
        <MetricCard label="Unique to you" help="Referring domains" />
        <MetricCard label="Shared" help="Referring domains" />
        <MetricCard label="Gap opportunities" help="Referring domains" />
      </div>
      <EmptyState
        tool="gap"
        title="Comparison data is not available yet"
        description="Enter a competitor domain — the comparison activates once the link index connects."
        action={false}
      />
    </section>
  )
}

export default function LinkIntelligenceView({ initialDomain = "" }: LinkIntelligenceViewProps) {
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

  const renderPanel = () => {
    if (activeWorkspace === "rating") return <RatingPanel domain={domain} />
    if (activeWorkspace === "pages") return <PagesPanel />
    if (activeWorkspace === "anchors") return <AnchorsPanel domain={domain} />
    if (activeWorkspace === "broken") return <BrokenPanel domain={domain} />
    if (activeWorkspace === "gap") return <GapPanel domain={domain} competitor={competitor} onCompetitorChange={setCompetitor} />
    return <ExplorerPanel domain={domain} />
  }

  return (
    <section className="link-intelligence-view li-workbench">
      <header className="li-top-row">
        <div>
          <h1>Understand your place in the web’s link graph</h1>
          <p>Every tool below reads from the same processed Common Crawl link index for the domain above.</p>
        </div>
        <span className="li-status"><i />Link index preparing</span>
      </header>

      <form className="li-search-bar" onSubmit={submitDomain}>
        <SearchIcon />
        <label htmlFor="link-intelligence-domain">Explore a domain</label>
        <input id="link-intelligence-domain" value={domainInput} onChange={(event) => setDomainInput(event.target.value)} placeholder="yourdomain.com" autoComplete="url" inputMode="url" />
        <button type="submit">Open workspace</button>
      </form>
      <p className="li-helper-line">Scores and tables activate automatically once the link index finishes processing — nothing to configure.</p>

      <div className="li-content-layout">
        <nav className="li-subnav" aria-label="Link intelligence tools">
          {WORKSPACES.map((workspace) => (
            <button key={workspace.id} type="button" className={activeWorkspace === workspace.id ? "is-active" : ""} onClick={() => setActiveWorkspace(workspace.id)}>
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
