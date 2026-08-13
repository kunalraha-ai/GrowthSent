import React, { useEffect, useMemo, useState } from "react";

interface SearchPerformanceViewProps {
  isGscConnected: boolean;
  websiteId: string | null;
}

interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface DailyRow extends Metrics {
  date: string;
}

interface QueryRow extends Metrics {
  query: string;
}

interface PageRow extends Metrics {
  page: string;
}

type ComparisonRow<T extends Metrics> = T & {
  previous: Metrics | null;
  change: Metrics | null;
};

export interface SearchIntelligenceReport {
  siteUrl: string;
  fetchedAt: string;
  periods: {
    current: { startDate: string; endDate: string; days: number };
    previous: { startDate: string; endDate: string; days: number };
  };
  overview: { current: Metrics; previous: Metrics; change: Metrics };
  availability: { overview: boolean; previousOverview: boolean; trend: boolean };
  dailySeries: DailyRow[];
  quickWins: Array<ComparisonRow<QueryRow>>;
  contentDecay: Array<ComparisonRow<PageRow>>;
  ctrOpportunities: Array<ComparisonRow<QueryRow>>;
  potentialCannibalization: Array<{
    query: string;
    pageCount: number;
    totalClicks: number;
    totalImpressions: number;
    pages: PageRow[];
  }>;
  winners: Array<{ kind: "query" | "page"; label: string; row: ComparisonRow<QueryRow | PageRow> }>;
  losers: Array<{ kind: "query" | "page"; label: string; row: ComparisonRow<QueryRow | PageRow> }>;
  keywords: Array<ComparisonRow<QueryRow>>;
  pages: Array<ComparisonRow<PageRow>>;
  reportedRowLimits: { queries: number; pages: number; queryPageCombinations: number };
}

type IntelligenceTab =
  | "overview"
  | "quick-wins"
  | "content-decay"
  | "ctr"
  | "cannibalization"
  | "winners-losers"
  | "keywords"
  | "pages";

const TAB_ITEMS: Array<{ id: IntelligenceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "quick-wins", label: "Quick wins" },
  { id: "content-decay", label: "Content decay" },
  { id: "ctr", label: "CTR opportunities" },
  { id: "cannibalization", label: "Potential cannibalization" },
  { id: "winners-losers", label: "Winners & losers" },
  { id: "keywords", label: "Keyword explorer" },
  { id: "pages", label: "Page explorer" },
];

const EXPLORER_PAGE_SIZE = 12;

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatPosition(value: number): string {
  return value > 0 ? value.toFixed(1) : "—";
}

function formatPageLabel(page: string): string {
  try {
    const url = new URL(page);
    return `${url.pathname || "/"}${url.search}`;
  } catch {
    return page;
  }
}

function metricDelta(value: number, type: "number" | "percent" | "position" = "number"): string {
  const prefix = value > 0 ? "+" : "";
  if (type === "percent") return `${prefix}${(value * 100).toFixed(1)} pp`;
  if (type === "position") return `${prefix}${value.toFixed(1)}`;
  return `${prefix}${formatNumber(value)}`;
}

function Delta({ value, type = "number" }: { value: number | null; type?: "number" | "percent" | "position" }) {
  if (value === null) return <span className="search-intelligence-delta muted">Unavailable</span>;
  const positiveIsGood = type === "position" ? value < 0 : value > 0;
  const className = value === 0 ? "muted" : positiveIsGood ? "positive" : "negative";
  return <span className={`search-intelligence-delta ${className}`}>{metricDelta(value, type)}</span>;
}

function MetricCard({
  label,
  value,
  delta,
  available,
  type = "number",
}: {
  label: string;
  value: string;
  delta: number | null;
  available: boolean;
  type?: "number" | "percent" | "position";
}) {
  return (
    <div className="metric-card search-intelligence-metric-card">
      <p className="metric-label">{label}</p>
      <b className="metric-val">{available ? value : "—"}</b>
      <span className="metric-sub text-muted">
        {available ? <><Delta value={delta} type={type} /> vs previous period</> : "No date-level GSC data reported"}
      </span>
    </div>
  );
}

function LoadingState() {
  return (
    <>
      <div className="metrics-grid search-intelligence-loading-grid" aria-label="Loading Search Console data">
        {["Clicks", "Impressions", "CTR", "Average position"].map((label) => (
          <div className="metric-card skeleton-card" key={label} aria-busy="true">
            <span className="metric-label">{label}</span>
            <span className="skeleton-line" style={{ width: "52%", height: "26px", marginTop: "8px" }} />
            <span className="skeleton-line" style={{ width: "68%", height: "12px", marginTop: "12px" }} />
          </div>
        ))}
      </div>
      <div className="console-section-card search-intelligence-section" aria-busy="true">
        <div className="card-header"><h4 className="card-title">Loading search intelligence</h4></div>
        <div className="search-intelligence-skeleton-lines"><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></div>
      </div>
    </>
  );
}

function EmptySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gsc-empty-state search-intelligence-empty-section">
      <div className="empty-icon-circle" aria-hidden="true">—</div>
      <h5>{title}</h5>
      <p>{children}</p>
    </div>
  );
}

function QueryRowsTable({ rows, emptyText }: { rows: Array<ComparisonRow<QueryRow>>; emptyText: string }) {
  if (!rows.length) return <EmptySection title="No reported query rows">{emptyText}</EmptySection>;
  return (
    <div className="table-wrapper">
      <table className="data-table search-intelligence-table">
        <thead><tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th>Click change</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.query}>
            <td className="search-intelligence-label" title={row.query}>{row.query}</td>
            <td>{formatNumber(row.clicks)}</td><td>{formatNumber(row.impressions)}</td><td>{formatPercent(row.ctr)}</td><td>{formatPosition(row.position)}</td>
            <td><Delta value={row.change?.clicks ?? null} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PageRowsTable({ rows, emptyText }: { rows: Array<ComparisonRow<PageRow>>; emptyText: string }) {
  if (!rows.length) return <EmptySection title="No reported page rows">{emptyText}</EmptySection>;
  return (
    <div className="table-wrapper">
      <table className="data-table search-intelligence-table">
        <thead><tr><th>Page</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th>Click change</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.page}>
            <td className="search-intelligence-label" title={row.page}>{formatPageLabel(row.page)}</td>
            <td>{formatNumber(row.clicks)}</td><td>{formatNumber(row.impressions)}</td><td>{formatPercent(row.ctr)}</td><td>{formatPosition(row.position)}</td>
            <td><Delta value={row.change?.clicks ?? null} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ExplorerTable({
  title,
  placeholder,
  rows,
  type,
}: {
  title: string;
  placeholder: string;
  rows: Array<ComparisonRow<QueryRow>> | Array<ComparisonRow<PageRow>>;
  type: "query" | "page";
}) {
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(() => {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => (type === "query" ? (row as ComparisonRow<QueryRow>).query : (row as ComparisonRow<PageRow>).page).toLowerCase().includes(normalized));
  }, [rows, term, type]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / EXPLORER_PAGE_SIZE));
  const visibleRows = filteredRows.slice((page - 1) * EXPLORER_PAGE_SIZE, page * EXPLORER_PAGE_SIZE);

  useEffect(() => setPage(1), [term, rows]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  return (
    <div className="console-section-card search-intelligence-section">
      <div className="card-header search-intelligence-card-header">
        <div><h4 className="card-title">{title}</h4><p className="card-sub">Reported Search Console {type}-level rows only.</p></div>
        <input className="form-input search-intelligence-filter" value={term} onChange={(event) => setTerm(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      </div>
      {type === "query"
        ? <QueryRowsTable rows={visibleRows as Array<ComparisonRow<QueryRow>>} emptyText="Search Console did not return query rows matching this filter." />
        : <PageRowsTable rows={visibleRows as Array<ComparisonRow<PageRow>>} emptyText="Search Console did not return page rows matching this filter." />}
      {filteredRows.length > EXPLORER_PAGE_SIZE && <div className="search-intelligence-pagination"><span>Page {page} of {totalPages}</span><div><button className="secondary-btn" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Previous</button><button className="secondary-btn" disabled={page === totalPages} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>}
    </div>
  );
}

function TrendCard({ dailySeries, available }: { dailySeries: DailyRow[]; available: boolean }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const chart = useMemo(() => {
    const width = 720;
    const height = 190;
    const margin = { top: 18, right: 14, bottom: 34, left: 14 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxClicks = Math.max(...dailySeries.map((row) => row.clicks), 1);
    const maxImpressions = Math.max(...dailySeries.map((row) => row.impressions), 1);
    const point = (value: number, maxValue: number, index: number) => ({
      x: margin.left + (index / Math.max(dailySeries.length - 1, 1)) * plotWidth,
      y: margin.top + (1 - value / maxValue) * plotHeight,
    });
    const path = (metric: "clicks" | "impressions", maxValue: number) => dailySeries.map((row, index) => {
      const { x, y } = point(row[metric], maxValue, index);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    }).join(" ");
    const labels = [0, Math.floor((dailySeries.length - 1) / 2), dailySeries.length - 1]
      .filter((index, position, values) => values.indexOf(index) === position)
      .map((index) => ({ index, ...point(0, 1, index) }));
    return { width, height, margin, plotWidth, plotHeight, clicksPath: path("clicks", maxClicks), impressionsPath: path("impressions", maxImpressions), labels, point };
  }, [dailySeries]);

  if (!available) {
    return <EmptySection title="Trend unavailable">Search Console did not return enough date-level rows for a trend visualization.</EmptySection>;
  }

  const activeRow = hoveredIndex === null ? null : dailySeries[hoveredIndex];
  return (
    <div className="search-intelligence-trend-body">
      <div className="search-intelligence-trend-legend"><span><i className="clicks" />Clicks</span><span><i className="impressions" />Impressions</span><small>Each line is scaled to its own reported range.</small></div>
      <div className="search-intelligence-chart-wrap">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Daily clicks and impressions from Google Search Console" className="search-intelligence-chart">
          <line x1={chart.margin.left} y1={chart.margin.top + chart.plotHeight} x2={chart.width - chart.margin.right} y2={chart.margin.top + chart.plotHeight} stroke="#deded7" />
          <line x1={chart.margin.left} y1={chart.margin.top + chart.plotHeight / 2} x2={chart.width - chart.margin.right} y2={chart.margin.top + chart.plotHeight / 2} stroke="#eeeeea" strokeDasharray="4 4" />
          <path d={chart.impressionsPath} fill="none" stroke="#262823" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d={chart.clicksPath} fill="none" stroke="#78bb24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {dailySeries.map((row, index) => {
            const clicksPoint = chart.point(row.clicks, Math.max(...dailySeries.map((item) => item.clicks), 1), index);
            return <circle key={row.date} cx={clicksPoint.x} cy={clicksPoint.y} r={hoveredIndex === index ? 4.5 : 2.5} fill="#a4ef51" stroke="#1b1c19" strokeWidth="1.2" onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />;
          })}
          {chart.labels.map(({ index, x }) => <text key={dailySeries[index].date} x={x} y={chart.height - 10} textAnchor="middle" fill="#777870" fontSize="10">{dailySeries[index].date}</text>)}
        </svg>
        {activeRow && <div className="search-intelligence-chart-tooltip"><strong>{activeRow.date}</strong><span>{formatNumber(activeRow.clicks)} clicks</span><span>{formatNumber(activeRow.impressions)} impressions</span></div>}
      </div>
    </div>
  );
}

function AnalysisSummaryCard({
  title,
  count,
  noun,
  plural,
  description,
  detail,
  onOpen,
}: {
  title: string;
  count: number;
  noun: string;
  plural: string;
  description: string;
  detail: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="console-section-card search-intelligence-summary-card" onClick={onOpen}>
      <span className="search-intelligence-summary-title">{title}</span>
      <strong>{count} {count === 1 ? noun : plural}</strong>
      <span>{count === 0 ? description : detail}</span>
      <em>View details →</em>
    </button>
  );
}

function ChangeList({ rows, emptyText }: { rows: SearchIntelligenceReport["winners"]; emptyText: string }) {
  if (!rows.length) return <EmptySection title="0 comparable rows">{emptyText}</EmptySection>;
  return <div className="search-intelligence-change-list">{rows.map(({ kind, label, row }) => <div key={`${kind}-${label}`} className="search-intelligence-change-row"><div><span className="search-intelligence-kind">{kind}</span><strong title={label}>{kind === "page" ? formatPageLabel(label) : label}</strong></div><div><Delta value={row.change?.clicks ?? null} /><span> clicks</span></div></div>)}</div>;
}

function DataCoverage({ report }: { report: SearchIntelligenceReport }) {
  return (
    <details className="search-intelligence-coverage">
      <summary>Data coverage &amp; methodology</summary>
      <div>
        <p>All figures are direct Google Search Console clicks, impressions, CTR, and average-position data. Overview values use date-level rows for the selected period and the comparable prior period.</p>
        <p>Search Console was asked for up to {report.reportedRowLimits.queries} query rows and {report.reportedRowLimits.pages} page rows for each period. Potential cannibalization is inferred from up to {report.reportedRowLimits.queryPageCombinations} current query–page rows and is not proof of a problem.</p>
        <p>Search volume, keyword difficulty, traffic estimates, authority, and unreported rows are not inferred.</p>
      </div>
    </details>
  );
}

export function SearchIntelligenceOverviewDashboard({ report, onOpenTab }: { report: SearchIntelligenceReport; onOpenTab: (tab: IntelligenceTab) => void }) {
  const topQueries = report.keywords.slice(0, 5);
  const topPages = report.pages.slice(0, 5);
  return (
    <div className="search-intelligence-overview-dashboard">
      <div className="console-section-card search-intelligence-section search-intelligence-trend-card">
        <div className="card-header"><div><h4 className="card-title">Search trend</h4><p className="card-sub">Daily clicks and impressions reported by Google Search Console for the selected period.</p></div></div>
        <TrendCard dailySeries={report.dailySeries} available={report.availability.trend} />
      </div>

      <div className="search-intelligence-summary-grid">
        <AnalysisSummaryCard title="Quick wins" count={report.quickWins.length} noun="opportunity" plural="opportunities" description="No reported queries meet the current position and impression criteria." detail={`Highest: ${report.quickWins[0]?.query || "reported query"}`} onOpen={() => onOpenTab("quick-wins")} />
        <AnalysisSummaryCard title="Content decay" count={report.contentDecay.length} noun="candidate" plural="candidates" description="No reported pages declined in clicks against a comparable prior row." detail={`Largest decline: ${formatPageLabel(report.contentDecay[0]?.page || "")}`} onOpen={() => onOpenTab("content-decay")} />
        <AnalysisSummaryCard title="CTR opportunities" count={report.ctrOpportunities.length} noun="opportunity" plural="opportunities" description="No reported queries meet the current CTR and visibility criteria." detail={`Highest visibility: ${report.ctrOpportunities[0]?.query || "reported query"}`} onOpen={() => onOpenTab("ctr")} />
        <AnalysisSummaryCard title="Potential cannibalization" count={report.potentialCannibalization.length} noun="query" plural="queries" description="No reported query has multiple qualifying pages in the bounded query–page data." detail={`Example: ${report.potentialCannibalization[0]?.query || "reported query"}`} onOpen={() => onOpenTab("cannibalization")} />
      </div>

      <div className="overview-two-col search-intelligence-overview-row">
        <div className="console-section-card search-intelligence-section"><div className="card-header flex-between"><div><h4 className="card-title">Top queries</h4><p className="card-sub">Query-level GSC observations.</p></div><button className="text-btn" onClick={() => onOpenTab("keywords")}>Explore →</button></div><QueryRowsTable rows={topQueries} emptyText="Search Console returned no query rows for this period." /></div>
        <div className="console-section-card search-intelligence-section"><div className="card-header flex-between"><div><h4 className="card-title">Top pages</h4><p className="card-sub">Page-level GSC observations.</p></div><button className="text-btn" onClick={() => onOpenTab("pages")}>Explore →</button></div><PageRowsTable rows={topPages} emptyText="Search Console returned no page rows for this period." /></div>
      </div>

      <div className="console-section-card search-intelligence-section">
        <div className="card-header"><h4 className="card-title">Winners &amp; losers</h4><p className="card-sub">Largest click changes among query and page rows reported in both periods.</p></div>
        <div className="overview-two-col search-intelligence-winners-grid"><div><h5>Winners</h5><ChangeList rows={report.winners.slice(0, 4)} emptyText="No reported query or page rows gained clicks in both periods." /></div><div><h5>Losers</h5><ChangeList rows={report.losers.slice(0, 4)} emptyText="No reported query or page rows lost clicks in both periods." /></div></div>
        <button className="text-btn search-intelligence-view-details" onClick={() => onOpenTab("winners-losers")}>View all comparable changes →</button>
      </div>
    </div>
  );
}

export function SearchPerformanceView({ isGscConnected, websiteId }: SearchPerformanceViewProps) {
  const [report, setReport] = useState<SearchIntelligenceReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState(28);
  const [activeTab, setActiveTab] = useState<IntelligenceTab>("overview");
  const [isConnecting, setIsConnecting] = useState(false);

  const fetchReport = async (signal?: AbortSignal) => {
    if (!isGscConnected || !websiteId) {
      setReport(null);
      return;
    }
    setIsLoading(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch(`/api/v1/search-intelligence?websiteId=${encodeURIComponent(websiteId)}&days=${days}`, { signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message || "Unable to load Search Console data.");
      if (!signal?.aborted) setReport(data as SearchIntelligenceReport);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Unable to load Search Console data.");
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetchReport(controller.signal);
    return () => controller.abort();
  }, [isGscConnected, websiteId, days]);

  const connectGsc = async () => {
    if (!websiteId) {
      setError("Add a website before connecting Google Search Console.");
      return;
    }
    setError("");
    setIsConnecting(true);
    try {
      const response = await fetch(`/api/v1/integrations/google/start?websiteId=${encodeURIComponent(websiteId)}&provider=google_search_console`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.authorizationUrl) throw new Error(data?.error?.message || "Unable to start Google OAuth.");
      window.location.assign(data.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Google OAuth.");
      setIsConnecting(false);
    }
  };

  if (!isGscConnected) {
    return (
      <div className="search-performance-view">
        <div className="console-title flex-between"><div><p className="kicker">Google Search Console</p><h3 className="title-text">Search Intelligence</h3></div><span className="status-pill warn">Disconnected</span></div>
        <div className="console-section-card search-intelligence-connect-card"><h4 className="card-title">Use your verified Search Console data</h4><p className="card-sub">Connect the Google account with access to this site’s Search Console property. GrowthSent uses the encrypted server-side connection to retrieve clicks, impressions, CTR, and average position.</p>{error && <p role="alert" className="search-intelligence-error">{error}</p>}<button className="primary-btn" onClick={connectGsc} disabled={isConnecting || !websiteId}>{isConnecting ? "Opening Google..." : "Connect Google Search Console"}</button></div>
      </div>
    );
  }

  const renderTab = () => {
    if (!report) return null;
    if (activeTab === "overview") return <SearchIntelligenceOverviewDashboard report={report} onOpenTab={setActiveTab} />;
    if (activeTab === "quick-wins") return <div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">Potential quick wins</h4><p className="card-sub">Query-level observations with at least 50 impressions and an average position from 4.0 to 20.0.</p></div><QueryRowsTable rows={report.quickWins} emptyText="No reported queries meet the current quick-win criteria." /></div>;
    if (activeTab === "content-decay") return <div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">Content decay candidates</h4><p className="card-sub">Page-level rows with fewer clicks than the prior period, where both periods were reported.</p></div><PageRowsTable rows={report.contentDecay} emptyText="No reported pages meet the current content-decay criteria." /></div>;
    if (activeTab === "ctr") return <div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">CTR opportunities</h4><p className="card-sub">Query-level rows with at least 100 impressions, position 10 or better, and CTR under 3%.</p></div><QueryRowsTable rows={report.ctrOpportunities} emptyText="No reported queries meet the current CTR opportunity criteria." /></div>;
    if (activeTab === "cannibalization") return <div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">Potential cannibalization</h4><p className="card-sub">Inferred when multiple URLs received impressions for the same query in bounded GSC query–page rows. It is not proof of a problem.</p></div>{report.potentialCannibalization.length ? <div className="search-intelligence-cannibalization-list">{report.potentialCannibalization.map((group) => <div key={group.query} className="search-intelligence-cannibalization-row"><div><strong title={group.query}>{group.query}</strong><span>{formatNumber(group.totalImpressions)} impressions across {group.pageCount} reported pages</span></div><ul>{group.pages.map((page) => <li key={page.page} title={page.page}>{formatPageLabel(page.page)} <small>{formatNumber(page.impressions)} imp.</small></li>)}</ul></div>)}</div> : <EmptySection title="0 potential cannibalization queries">No query with multiple qualifying pages was found in the bounded query–page data.</EmptySection>}</div>;
    if (activeTab === "winners-losers") return <div className="overview-two-col"><div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">Winners</h4><p className="card-sub">Largest positive click changes among comparable rows.</p></div><ChangeList rows={report.winners} emptyText="No comparable gains were returned." /></div><div className="console-section-card search-intelligence-section"><div className="card-header"><h4 className="card-title">Losers</h4><p className="card-sub">Largest negative click changes among comparable rows.</p></div><ChangeList rows={report.losers} emptyText="No comparable declines were returned." /></div></div>;
    if (activeTab === "keywords") return <ExplorerTable title="Keyword explorer" placeholder="Filter reported queries" rows={report.keywords} type="query" />;
    return <ExplorerTable title="Page explorer" placeholder="Filter reported pages" rows={report.pages} type="page" />;
  };

  return (
    <div className="search-performance-view search-intelligence-view">
      <div className="console-title search-intelligence-title-row"><div><p className="kicker">Google Search Console</p><h3 className="title-text">Search Intelligence</h3>{report?.siteUrl && <p className="card-sub">Property: {report.siteUrl}</p>}</div><div className="search-intelligence-controls"><label><span className="sr-only">Period</span><select className="filter-select" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={28}>Last 28 days</option><option value={90}>Last 90 days</option></select></label><button className="secondary-btn" onClick={() => void fetchReport()} disabled={isLoading}>{isLoading ? "Refreshing..." : "Refresh"}</button></div></div>
      {error && <div role="alert" className="search-intelligence-error search-intelligence-error-banner"><span>{error}</span><button className="secondary-btn" onClick={() => void fetchReport()} disabled={isLoading}>Retry</button></div>}
      {isLoading && !report ? <LoadingState /> : report && <>
        <div className="search-intelligence-period">Current: {report.periods.current.startDate} to {report.periods.current.endDate} · Compared with: {report.periods.previous.startDate} to {report.periods.previous.endDate}</div>
        <div className="metrics-grid search-intelligence-metrics-grid">
          <MetricCard label="Clicks" value={formatNumber(report.overview.current.clicks)} delta={report.availability.previousOverview ? report.overview.change.clicks : null} available={report.availability.overview} />
          <MetricCard label="Impressions" value={formatNumber(report.overview.current.impressions)} delta={report.availability.previousOverview ? report.overview.change.impressions : null} available={report.availability.overview} />
          <MetricCard label="Average CTR" value={formatPercent(report.overview.current.ctr)} delta={report.availability.previousOverview ? report.overview.change.ctr : null} available={report.availability.overview} type="percent" />
          <MetricCard label="Average position" value={formatPosition(report.overview.current.position)} delta={report.availability.previousOverview ? report.overview.change.position : null} available={report.availability.overview} type="position" />
        </div>
        <div className="search-intelligence-tabs" role="tablist" aria-label="Search intelligence sections">{TAB_ITEMS.map((tab) => <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</div>
        {renderTab()}
        <DataCoverage report={report} />
      </>}
    </div>
  );
}
