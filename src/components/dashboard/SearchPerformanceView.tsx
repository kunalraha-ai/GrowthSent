import React, { useEffect, useMemo, useState } from "react";

interface SearchPerformanceViewProps {
  isGscConnected: boolean;
  websiteId: string | null;
  onNavigateTab: (tab: string) => void;
}

interface SearchQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function SearchPerformanceView({ isGscConnected, websiteId, onNavigateTab }: SearchPerformanceViewProps) {
  const [queries, setQueries] = useState<SearchQuery[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isGscConnected || !websiteId) {
      setQueries([]);
      return;
    }
    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/v1/search-performance?websiteId=${websiteId}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "Unable to load Search Console data.");
        setQueries(data.queries || []);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load Search Console data.");
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [isGscConnected, websiteId]);

  const summary = useMemo(() => {
    const clicks = queries.reduce((total, item) => total + item.clicks, 0);
    const impressions = queries.reduce((total, item) => total + item.impressions, 0);
    return {
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: queries.length ? queries.reduce((total, item) => total + item.position, 0) / queries.length : 0,
    };
  }, [queries]);

  if (!isGscConnected) {
    return (
      <div className="search-performance-view">
        <div className="console-title"><h3 className="title-text">Search Performance</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "24px", padding: "48px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: "20px", fontWeight: 800 }}>Connect Google Search Console</h3>
          <p className="card-sub">Search clicks, impressions, queries, CTR, and positions are shown only after a real Google Search Console connection is authorized.</p>
          <button className="primary-btn" onClick={() => onNavigateTab("gsc")}>Connect Google Search Console →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="search-performance-view">
      <div className="console-title flex-between">
        <h3 className="title-text">Search Performance</h3>
        <button className="secondary-btn" onClick={() => onNavigateTab("gsc")}>Manage connection</button>
      </div>
      {error && <p role="alert" style={{ color: "#b42318", marginTop: "16px" }}>{error}</p>}
      <div className="metrics-grid" style={{ marginTop: "20px" }}>
        <div className="metric-card"><p className="metric-label">Organic Clicks</p><b className="metric-val">{summary.clicks.toLocaleString()}</b><span className="metric-sub text-muted">Last 28 days</span></div>
        <div className="metric-card"><p className="metric-label">Impressions</p><b className="metric-val">{summary.impressions.toLocaleString()}</b><span className="metric-sub text-muted">Last 28 days</span></div>
        <div className="metric-card"><p className="metric-label">Average CTR</p><b className="metric-val">{(summary.ctr * 100).toFixed(1)}%</b><span className="metric-sub text-muted">Clicks ÷ impressions</span></div>
        <div className="metric-card"><p className="metric-label">Average Position</p><b className="metric-val">{summary.position ? summary.position.toFixed(1) : "—"}</b><span className="metric-sub text-muted">Across returned queries</span></div>
      </div>
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header"><h4 className="card-title">Top Search Queries</h4></div>
        {isLoading ? <p className="card-sub" style={{ padding: "20px" }}>Loading Search Console data…</p> : queries.length === 0 ? (
          <p className="card-sub" style={{ padding: "20px" }}>Google did not return query data for the selected property and date range.</p>
        ) : (
          <div style={{ overflowX: "auto" }}><table className="data-table"><thead><tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th></tr></thead><tbody>
            {queries.map((item) => <tr key={item.query}><td>{item.query}</td><td>{item.clicks}</td><td>{item.impressions}</td><td>{(item.ctr * 100).toFixed(1)}%</td><td>{item.position.toFixed(1)}</td></tr>)}
          </tbody></table></div>
        )}
      </div>
    </div>
  );
}
