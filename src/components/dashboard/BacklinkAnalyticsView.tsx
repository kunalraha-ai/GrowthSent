import React, { FormEvent, useEffect, useRef, useState } from "react";
import { MetricSkeleton } from "./SkeletonLoaders";

interface BacklinkRow {
  sourceUrl: string;
  sourceHost: string | null;
  targetUrl: string;
  anchor: string | null;
  crawledAt: string | null;
}

interface RankedValue {
  value: string;
  backlinkCount: number;
}

interface LinkedPage extends RankedValue {
  referringDomainCount: number;
}

interface BacklinkReport {
  domain: string;
  coverage: { crawl: string; label: string; resultLabel: string; exactHostnameOnly: true };
  overview: {
    totalBacklinks: number | null;
    uniqueReferringDomains: number | null;
    uniqueLinkedPages: number | null;
    uniqueAnchors: number | null;
    uniqueAnchorsCapped: boolean;
  };
  partial: boolean;
  unavailableSections: string[];
  backlinks: BacklinkRow[];
  pagination: { page: number; pageSize: number; totalRows: number | null; totalPages: number | null };
  referringDomains: RankedValue[];
  topAnchors: RankedValue[];
  topLinkedPages: LinkedPage[];
}

interface BacklinkAnalyticsViewProps {
  initialDomain?: string;
}

type BacklinkTab = "backlinks" | "domains" | "anchors" | "pages";

const TAB_OPTIONS: Array<{ id: BacklinkTab; label: string }> = [
  { id: "backlinks", label: "Link Observations" },
  { id: "domains", label: "Referring Domains" },
  { id: "anchors", label: "Top Anchors" },
  { id: "pages", label: "Top Linked Pages" },
];

function formatCount(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCrawledAt(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3h7v7" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function TruncatedValue({ value, emptyText = "Not recorded", className = "" }: { value: string | null; emptyText?: string; className?: string }) {
  if (!value) return <span className="backlink-empty-value">{emptyText}</span>;
  return <span className={`backlink-truncate ${className}`} title={value} aria-label={value}>{value}</span>;
}

function UrlCell({ url }: { url: string }) {
  if (!url) return <span className="backlink-empty-value">Not recorded</span>;
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return <TruncatedValue value={url} className="backlink-url" />;
  return (
    <a className="url-link-text backlink-url backlink-url-link" href={safeUrl} target="_blank" rel="noreferrer" title={url} aria-label={`Open ${url} in a new tab`}>
      <span>{url}</span><ExternalLinkIcon />
    </a>
  );
}

function BacklinkTableSkeleton() {
  return (
    <div className="backlink-table-skeleton" aria-label="Loading backlinks" aria-live="polite">
      <div className="backlink-skeleton-rows">
        {Array.from({ length: 6 }).map((_, index) => <div className="skeleton-line" key={index} style={{ height: "48px" }} />)}
      </div>
    </div>
  );
}

function BacklinkAnalyticsSkeleton() {
  return (
    <div className="backlink-skeleton" aria-label="Loading backlink analytics" aria-live="polite">
      <div className="metrics-grid backlink-metrics-grid">
        {Array.from({ length: 4 }).map((_, index) => <MetricSkeleton key={index} />)}
      </div>
      <section className="console-section-card backlink-section backlink-table-skeleton">
        <div className="card-header"><div className="skeleton-line" style={{ width: "160px", height: "16px" }} /></div>
        <BacklinkTableSkeleton />
      </section>
    </div>
  );
}

function EmptyRankedRows({ message }: { message: string }) {
  return <p className="backlink-empty-list">{message}</p>;
}

export default function BacklinkAnalyticsView({ initialDomain = "" }: BacklinkAnalyticsViewProps) {
  const [domainInput, setDomainInput] = useState(initialDomain);
  const [report, setReport] = useState<BacklinkReport | null>(null);
  const [activeTab, setActiveTab] = useState<BacklinkTab>("backlinks");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!domainInput && initialDomain) setDomainInput(initialDomain);
  }, [domainInput, initialDomain]);

  const loadReport = async (page = 1, requestedDomain = domainInput, preserveResults = false) => {
    const domain = requestedDomain.trim();
    if (!domain) {
      setError("Enter a domain, such as github.com.");
      setErrorCode("INVALID_DOMAIN");
      setReport(null);
      return;
    }

    const requestId = ++requestSequence.current;
    if (!preserveResults) setReport(null);
    setLoading(true);
    setError("");
    setErrorCode("");

    try {
      const params = new URLSearchParams({ domain, page: String(page), pageSize: "25" });
      const response = await fetch(`/api/v1/backlinks?${params.toString()}`, { headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const requestError = new Error(data?.error?.message || "Unable to load backlink preview data.") as Error & { code?: string };
        requestError.code = data?.error?.code;
        throw requestError;
      }
      if (requestId !== requestSequence.current) return;
      setReport(data as BacklinkReport);
      setDomainInput(data.domain);
    } catch (requestError) {
      if (requestId !== requestSequence.current) return;
      const code = requestError && typeof requestError === "object" && "code" in requestError
        ? String((requestError as { code?: string }).code || "")
        : "";
      setErrorCode(code);
      setError(requestError instanceof Error ? requestError.message : "Unable to load backlink preview data.");
      if (!preserveResults) setReport(null);
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void loadReport(1);
  };

  const retry = () => void loadReport(report?.pagination.page || 1, report?.domain || domainInput, Boolean(report));
  const queryTimeout = errorCode === "QUERY_TIMEOUT";
  const hasResults = Boolean(report && (report.backlinks.length > 0 || (report.overview.totalBacklinks !== null && report.overview.totalBacklinks > 0)));
  const canLoadNextPage = Boolean(report && (report.pagination.totalPages === null
    ? report.backlinks.length === report.pagination.pageSize
    : report.pagination.page < report.pagination.totalPages));

  return (
    <section className="backlinks-view">
      <div className="console-title backlink-page-title">
        <div>
          <p>BACKLINK ANALYTICS</p>
          <h3>Preview external link observations</h3>
        </div>
        <span className="backlink-preview-badge">Preview data</span>
      </div>

      <form className="backlink-search-form" onSubmit={handleSubmit}>
        <label className="backlink-search-label" htmlFor="backlink-domain">Search a domain</label>
        <div className="backlink-search-controls">
          <div className="backlink-search-input-wrap">
            <SearchIcon />
            <input
              id="backlink-domain"
              className="form-input"
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              placeholder="github.com"
              autoComplete="url"
              inputMode="url"
              disabled={loading}
            />
          </div>
          <button className="backlink-search-button" type="submit" disabled={loading}>
            {loading ? "Searching..." : "Search link observations"}
          </button>
        </div>
        <p className="backlink-search-help">Enter a domain, URL, www domain, or trailing slash.</p>
      </form>

      <div className="backlink-coverage-notice" role="note">
        Preview coverage — first 1,000 WAT files from CC-MAIN-2026-30. This is not a full-web backlink index.
      </div>

      {report?.partial && (
        <div className="backlink-coverage-notice" role="status">
          Some preview sections exceeded the query bound. Available results are shown; unavailable counts are marked —.
        </div>
      )}

      {error && (
        <div className="backlink-state backlink-error" role="alert">
          <div>
            <strong>{queryTimeout ? "This preview query timed out." : "Could not load backlink data."}</strong>
            <p>{queryTimeout ? "The available data is large for this domain. The query was stopped to keep the preview responsive; try again shortly." : error}</p>
          </div>
          <button type="button" className="backlink-secondary-button" onClick={retry}>Try again</button>
        </div>
      )}

      {loading && !report && <BacklinkAnalyticsSkeleton />}

      {report && !hasResults && !loading && (
        <div className="backlink-empty-state">
          <div className="backlink-empty-icon" aria-hidden="true"><SearchIcon /></div>
          <h4>{report.unavailableSections.includes("backlinks") ? "Link observations were not available" : "No external link observations in this preview"}</h4>
          <p>{report.unavailableSections.includes("backlinks")
            ? "The bounded lookup did not complete. Try again shortly; no backlink totals or SEO metrics were inferred."
            : <>We found no external link observations for <strong>{report.domain}</strong> in this bounded preview. This is not a statement about the wider web.</>}</p>
          <button type="button" className="backlink-secondary-button" onClick={() => document.getElementById("backlink-domain")?.focus()}>Search another domain</button>
        </div>
      )}

      {hasResults && report && (
        <>
          <div className="backlink-result-heading">
            <div>
              <p>RESULTS FOR</p>
              <h4>{report.domain}</h4>
            </div>
            <span>{report.overview.totalBacklinks === null ? `${report.backlinks.length} external observations returned` : `${formatCount(report.overview.totalBacklinks)} rows`}</span>
          </div>

          <section aria-labelledby="backlink-overview-title">
            <h4 id="backlink-overview-title" className="backlink-section-label">Overview</h4>
            <div className="metrics-grid backlink-metrics-grid">
              <div className="metric-card backlink-metric-card"><p className="metric-label">OBSERVATIONS</p><strong className="metric-val">{formatCount(report.overview.totalBacklinks)}</strong><span className="metric-sub text-muted">External rows in preview</span></div>
              <div className="metric-card backlink-metric-card"><p className="metric-label">SOURCE DOMAINS</p><strong className="metric-val">{formatCount(report.overview.uniqueReferringDomains)}</strong><span className="metric-sub text-muted">Unavailable when bounded</span></div>
              <div className="metric-card backlink-metric-card"><p className="metric-label">LINKED PAGES</p><strong className="metric-val">{formatCount(report.overview.uniqueLinkedPages)}</strong><span className="metric-sub text-muted">Unique target URLs</span></div>
              <div className="metric-card backlink-metric-card"><p className="metric-label">ANCHORS</p><strong className="metric-val">{report.overview.uniqueAnchorsCapped ? "10,000+" : formatCount(report.overview.uniqueAnchors)}</strong><span className="metric-sub text-muted">Non-empty anchor text</span></div>
            </div>
          </section>

          <div className="backlink-tabs" role="tablist" aria-label="Backlink analytics sections">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`backlink-tab-${tab.id}`}
                aria-controls={`backlink-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "is-active" : ""}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "backlinks" && (
            <section id="backlink-panel-backlinks" role="tabpanel" aria-labelledby="backlink-tab-backlinks" className="console-section-card backlink-section">
              <div className="card-header backlink-card-header">
                <div><h4 className="card-title">External Link Observations</h4><p className="card-sub">{report.coverage.resultLabel}. Exact-host lookup for {report.domain}; internal same-registrable-domain links are excluded from this bounded sample.</p></div>
                <span className="backlink-page-size">{report.pagination.pageSize} per page</span>
              </div>
              {loading ? <BacklinkTableSkeleton /> : (
                <>
                  <div className="table-wrapper">
                    <table className="data-table backlink-table">
                      <thead><tr><th>Source domain</th><th>Source URL</th><th>Target URL</th><th>Anchor</th><th>Crawl date</th></tr></thead>
                      <tbody>{report.backlinks.map((backlink, index) => (
                        <tr key={`${backlink.sourceUrl}-${backlink.targetUrl}-${backlink.crawledAt || ""}-${index}`}>
                          <td><TruncatedValue value={backlink.sourceHost} className="backlink-domain-cell" /></td>
                          <td><UrlCell url={backlink.sourceUrl} /></td>
                          <td><UrlCell url={backlink.targetUrl} /></td>
                          <td><TruncatedValue value={backlink.anchor} emptyText="No anchor text" className="backlink-anchor" /></td>
                          <td className="backlink-date-cell">{formatCrawledAt(backlink.crawledAt)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className="backlink-pagination">
                    <span>Page <strong>{report.pagination.page}</strong> of {formatCount(report.pagination.totalPages)}</span>
                    <div>
                      <button type="button" onClick={() => void loadReport(report.pagination.page - 1, report.domain, true)} disabled={report.pagination.page <= 1}>Previous</button>
                      <button type="button" onClick={() => void loadReport(report.pagination.page + 1, report.domain, true)} disabled={!canLoadNextPage}>Next</button>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {activeTab === "domains" && (
            <section id="backlink-panel-domains" role="tabpanel" aria-labelledby="backlink-tab-domains" className="console-section-card backlink-section">
              <div className="card-header"><h4 className="card-title">Source Domains</h4><p className="card-sub">Unavailable unless a bounded aggregate can be computed without a broad scan.</p></div>
              <div className="table-wrapper"><table className="data-table backlink-ranked-table"><thead><tr><th>Domain</th><th>Backlink count</th></tr></thead><tbody>
                {report.referringDomains.map((item) => <tr key={item.value}><td><TruncatedValue value={item.value} className="backlink-domain-cell" /></td><td className="backlink-count-cell">{formatCount(item.backlinkCount)}</td></tr>)}
              </tbody></table></div>
              {report.referringDomains.length === 0 && <EmptyRankedRows message="Source-domain totals are not computed from this bounded preview." />}
            </section>
          )}

          {activeTab === "anchors" && (
            <section id="backlink-panel-anchors" role="tabpanel" aria-labelledby="backlink-tab-anchors" className="console-section-card backlink-section">
              <div className="card-header"><h4 className="card-title">Top Anchors</h4><p className="card-sub">Unavailable unless a bounded aggregate can be computed without a broad scan.</p></div>
              <div className="table-wrapper"><table className="data-table backlink-ranked-table"><thead><tr><th>Anchor text</th><th>Backlink count</th></tr></thead><tbody>
                {report.topAnchors.map((item) => <tr key={item.value}><td><TruncatedValue value={item.value} className="backlink-anchor" /></td><td className="backlink-count-cell">{formatCount(item.backlinkCount)}</td></tr>)}
              </tbody></table></div>
              {report.topAnchors.length === 0 && <EmptyRankedRows message="No non-empty anchor text is available for this preview." />}
            </section>
          )}

          {activeTab === "pages" && (
            <section id="backlink-panel-pages" role="tabpanel" aria-labelledby="backlink-tab-pages" className="console-section-card backlink-section">
              <div className="card-header"><h4 className="card-title">Top Linked Pages</h4><p className="card-sub">Unavailable unless a bounded aggregate can be computed without a broad scan.</p></div>
              <div className="table-wrapper"><table className="data-table backlink-ranked-table"><thead><tr><th>Target URL</th><th>Backlinks</th><th>Referring domains</th></tr></thead><tbody>
                {report.topLinkedPages.map((item) => <tr key={item.value}><td><UrlCell url={item.value} /></td><td className="backlink-count-cell">{formatCount(item.backlinkCount)}</td><td className="backlink-count-cell">{formatCount(item.referringDomainCount)}</td></tr>)}
              </tbody></table></div>
              {report.topLinkedPages.length === 0 && <EmptyRankedRows message="No linked pages are available for this preview." />}
            </section>
          )}
        </>
      )}
    </section>
  );
}
