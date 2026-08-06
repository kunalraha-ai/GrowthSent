import React, { useEffect, useMemo, useState } from "react";

interface SearchPerformanceViewProps {
  isGscConnected: boolean;
  websiteId: string | null;
  onNavigateTab: (tab: string) => void;
}

interface GscReportData {
  connected: boolean;
  siteUrl: string;
  lastSynced: string;
  dateRange: {
    startDate: string;
    endDate: string;
    days: number;
  };
  summary: {
    totalClicks: number;
    totalImpressions: number;
    avgCtr: number;
    avgPosition: number;
  };
  dailySeries: Array<{
    date: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  topQueries: Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  topPages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  countries: Array<{
    country: string;
    countryCode: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  devices: Array<{
    device: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  searchAppearance: Array<{
    appearance: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  sitemaps: Array<{
    path: string;
    lastDownloaded: string;
    isPending: boolean;
    isWarnings: boolean;
    hasErrors: boolean;
    type: string;
    submitted: number;
    indexed: number;
  }>;
  opportunities: Array<{
    id: string;
    type: "low_ctr" | "striking_distance" | "zero_clicks" | "top_performing";
    title: string;
    description: string;
    queryOrPage: string;
    metrics: { clicks: number; impressions: number; ctr: number; position: number };
  }>;
  indexingOverview?: {
    indexedPages: number;
    notIndexed: number;
    errors: number;
    excluded: number;
  };
  coverageIssues?: Array<{
    title: string;
    severity: string;
    affectedUrl: string;
    description: string;
  }>;
}

type ActiveChartMetric = "clicks" | "impressions" | "ctr" | "position";

export function SearchPerformanceView({ isGscConnected, websiteId, onNavigateTab }: SearchPerformanceViewProps) {
  const [report, setReport] = useState<GscReportData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState<number>(28);
  const [selectedChartMetric, setSelectedChartMetric] = useState<ActiveChartMetric>("clicks");

  // Query table search & pagination
  const [querySearch, setQuerySearch] = useState("");
  const [queryPage, setQueryPage] = useState(1);
  const itemsPerPage = 10;

  // Page table search & pagination
  const [pageSearch, setPageSearch] = useState("");
  const [pageNumber, setPageNumber] = useState(1);

  // Hover state for interactive SVG chart
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  const fetchReport = async () => {
    if (!isGscConnected || !websiteId) {
      setReport(null);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/gsc-full-report?websiteId=${websiteId}&days=${days}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Unable to load Search Console report.");
      setReport(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Search Console data.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [isGscConnected, websiteId, days]);

  // Filtered queries
  const filteredQueries = useMemo(() => {
    if (!report?.topQueries) return [];
    if (!querySearch.trim()) return report.topQueries;
    const term = querySearch.toLowerCase();
    return report.topQueries.filter((q) => q.query.toLowerCase().includes(term));
  }, [report?.topQueries, querySearch]);

  const paginatedQueries = useMemo(() => {
    const start = (queryPage - 1) * itemsPerPage;
    return filteredQueries.slice(start, start + itemsPerPage);
  }, [filteredQueries, queryPage]);

  const totalQueryPages = Math.ceil(filteredQueries.length / itemsPerPage) || 1;

  // Filtered pages
  const filteredPages = useMemo(() => {
    if (!report?.topPages) return [];
    if (!pageSearch.trim()) return report.topPages;
    const term = pageSearch.toLowerCase();
    return report.topPages.filter((p) => p.page.toLowerCase().includes(term));
  }, [report?.topPages, pageSearch]);

  const paginatedPages = useMemo(() => {
    const start = (pageNumber - 1) * itemsPerPage;
    return filteredPages.slice(start, start + itemsPerPage);
  }, [filteredPages, pageNumber]);

  const totalPagePages = Math.ceil(filteredPages.length / itemsPerPage) || 1;

  // Render Not Connected State
  if (!isGscConnected) {
    return (
      <div className="search-performance-view">
        <div className="console-title"><h3 className="title-text">Search Performance</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "24px", padding: "56px 24px", textAlign: "center" }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔍</div>
          <h3 style={{ fontSize: "22px", fontWeight: 800, margin: "0 0 12px 0" }}>Connect Google Search Console</h3>
          <p className="card-sub" style={{ maxWidth: "520px", margin: "0 auto 24px auto", lineHeight: "1.6" }}>
            Authorize your Search Console property to unlock real organic search clicks, impression trends, keyword rankings, top performing pages, device breakdowns, and automated SEO opportunities.
          </p>
          <button className="primary-btn" onClick={() => onNavigateTab("gsc")}>Connect Google Search Console →</button>
        </div>
      </div>
    );
  }

  const series = report?.dailySeries || [];
  const summary = report?.summary || { totalClicks: 0, totalImpressions: 0, avgCtr: 0, avgPosition: 0 };

  // Calculate SVG Chart path points
  const chartHeight = 220;
  const chartWidth = 720;
  const padding = 20;

  const metricValues = series.map((d) => {
    if (selectedChartMetric === "clicks") return d.clicks;
    if (selectedChartMetric === "impressions") return d.impressions;
    if (selectedChartMetric === "ctr") return d.ctr * 100;
    return d.position;
  });

  const maxVal = Math.max(...metricValues, 1);
  const minVal = selectedChartMetric === "position" ? Math.min(...metricValues, 1) : 0;
  const valRange = maxVal - minVal || 1;

  const points = series.map((d, idx) => {
    const x = padding + (idx / Math.max(series.length - 1, 1)) * (chartWidth - padding * 2);
    const rawVal = selectedChartMetric === "clicks" ? d.clicks : selectedChartMetric === "impressions" ? d.impressions : selectedChartMetric === "ctr" ? d.ctr * 100 : d.position;
    // For position, lower number is better (top of chart)
    const normalized = selectedChartMetric === "position" ? (maxVal - rawVal) / valRange : (rawVal - minVal) / valRange;
    const y = chartHeight - padding - normalized * (chartHeight - padding * 2);
    return { x, y, date: d.date, rawVal };
  });

  const svgPathD = points.length > 0
    ? points.reduce((acc, pt, i) => (i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`), "")
    : "";

  const areaPathD = points.length > 0
    ? `${svgPathD} L ${points[points.length - 1].x} ${chartHeight - padding} L ${points[0].x} ${chartHeight - padding} Z`
    : "";

  const formatMetricVal = (val: number, type: ActiveChartMetric) => {
    if (type === "clicks" || type === "impressions") return Math.round(val).toLocaleString();
    if (type === "ctr") return `${val.toFixed(1)}%`;
    return `#${val.toFixed(1)}`;
  };

  return (
    <div className="search-performance-view" style={{ color: "#f7f7f3" }}>
      {/* Header Controls */}
      <div className="console-title flex-between" style={{ flexWrap: "wrap", gap: "16px", marginBottom: "24px" }}>
        <div>
          <h3 className="title-text" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            Search Performance
            <span style={{ fontSize: "12px", background: "#17381e", color: "#a4ef51", border: "1px solid #28542e", padding: "2px 10px", borderRadius: "12px", fontWeight: 700 }}>
              ● Connected
            </span>
          </h3>
          {report?.siteUrl && <small style={{ color: "#888982" }}>Property: {report.siteUrl}</small>}
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          {/* Date Selector */}
          <div style={{ background: "#161815", border: "1px solid #2a2c28", borderRadius: "8px", padding: "3px", display: "flex", gap: "2px" }}>
            {[
              { label: "7 Days", val: 7 },
              { label: "28 Days", val: 28 },
              { label: "90 Days", val: 90 },
              { label: "12 Months", val: 365 },
            ].map((item) => (
              <button
                key={item.val}
                onClick={() => setDays(item.val)}
                style={{
                  background: days === item.val ? "#a4ef51" : "transparent",
                  color: days === item.val ? "#0e0f0e" : "#a5a69f",
                  border: "none",
                  padding: "5px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: days === item.val ? 800 : 600,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            onClick={fetchReport}
            disabled={isLoading}
            className="secondary-btn"
            style={{ padding: "6px 14px", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}
          >
            <span style={{ display: "inline-block", animation: isLoading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {isLoading ? "Syncing..." : "Refresh"}
          </button>

          <button className="text-btn" onClick={() => onNavigateTab("gsc")}>Manage</button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ marginBottom: "24px", padding: "14px 18px", borderRadius: "10px", color: "#f87171", background: "#2a1515", border: "1px solid #5c2020", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{error}</span>
          <button onClick={fetchReport} style={{ background: "transparent", border: "1px solid #f87171", color: "#f87171", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}>Retry</button>
        </div>
      )}

      {/* KPI Cards (4 metrics) */}
      <div className="metrics-grid" style={{ gap: "16px" }}>
        <div className="metric-card" style={{ background: "#141513", border: "1px solid #232521", borderRadius: "12px", padding: "20px" }}>
          <p className="metric-label" style={{ color: "#888982", fontSize: "13px", margin: "0 0 8px 0" }}>Total Clicks</p>
          <b className="metric-val" style={{ fontSize: "28px", color: "#f7f7f3" }}>{isLoading ? "..." : summary.totalClicks.toLocaleString()}</b>
          <span className="metric-sub text-muted" style={{ fontSize: "12px", color: "#6e7068" }}>Last {days} days</span>
        </div>

        <div className="metric-card" style={{ background: "#141513", border: "1px solid #232521", borderRadius: "12px", padding: "20px" }}>
          <p className="metric-label" style={{ color: "#888982", fontSize: "13px", margin: "0 0 8px 0" }}>Total Impressions</p>
          <b className="metric-val" style={{ fontSize: "28px", color: "#60a5fa" }}>{isLoading ? "..." : summary.totalImpressions.toLocaleString()}</b>
          <span className="metric-sub text-muted" style={{ fontSize: "12px", color: "#6e7068" }}>Search visibility</span>
        </div>

        <div className="metric-card" style={{ background: "#141513", border: "1px solid #232521", borderRadius: "12px", padding: "20px" }}>
          <p className="metric-label" style={{ color: "#888982", fontSize: "13px", margin: "0 0 8px 0" }}>Average CTR</p>
          <b className="metric-val" style={{ fontSize: "28px", color: "#a4ef51" }}>{isLoading ? "..." : `${(summary.avgCtr * 100).toFixed(1)}%`}</b>
          <span className="metric-sub text-muted" style={{ fontSize: "12px", color: "#6e7068" }}>Click-through rate</span>
        </div>

        <div className="metric-card" style={{ background: "#141513", border: "1px solid #232521", borderRadius: "12px", padding: "20px" }}>
          <p className="metric-label" style={{ color: "#888982", fontSize: "13px", margin: "0 0 8px 0" }}>Average Position</p>
          <b className="metric-val" style={{ fontSize: "28px", color: "#c084fc" }}>{isLoading ? "..." : summary.avgPosition ? summary.avgPosition.toFixed(1) : "—"}</b>
          <span className="metric-sub text-muted" style={{ fontSize: "12px", color: "#6e7068" }}>Average search rank</span>
        </div>
      </div>

      {/* Interactive Performance Chart */}
      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
          <h4 className="card-title" style={{ margin: 0, fontSize: "16px", fontWeight: 800 }}>Performance Over Time</h4>

          {/* Metric Selector Tabs */}
          <div style={{ display: "flex", gap: "6px", background: "#1a1c19", padding: "3px", borderRadius: "8px", border: "1px solid #292b26" }}>
            {[
              { key: "clicks", label: "Clicks", color: "#a4ef51" },
              { key: "impressions", label: "Impressions", color: "#60a5fa" },
              { key: "ctr", label: "CTR", color: "#34d399" },
              { key: "position", label: "Avg Position", color: "#c084fc" },
            ].map((m) => (
              <button
                key={m.key}
                onClick={() => setSelectedChartMetric(m.key as ActiveChartMetric)}
                style={{
                  background: selectedChartMetric === m.key ? "#272a25" : "transparent",
                  color: selectedChartMetric === m.key ? m.color : "#888982",
                  border: selectedChartMetric === m.key ? `1px solid ${m.color}40` : "1px solid transparent",
                  padding: "6px 14px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* SVG Chart Container */}
        {isLoading ? (
          <div style={{ height: `${chartHeight}px`, display: "flex", alignItems: "center", justifyContent: "center", color: "#888982" }}>
            Loading Search Console timeline...
          </div>
        ) : series.length === 0 ? (
          <div style={{ height: `${chartHeight}px`, display: "flex", alignItems: "center", justifyContent: "center", color: "#888982", textAlign: "center" }}>
            No timeline data returned by Google Search Console for the selected range.
          </div>
        ) : (
          <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
            <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} style={{ width: "100%", height: "240px", overflow: "visible" }}>
              <defs>
                <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a4ef51" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#a4ef51" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Area Fill */}
              <path d={areaPathD} fill="url(#chartGradient)" />

              {/* Line */}
              <path d={svgPathD} fill="none" stroke="#a4ef51" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* Interactive Data Points */}
              {points.map((pt, idx) => (
                <g key={pt.date}>
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={hoveredPointIndex === idx ? "6" : "3.5"}
                    fill="#a4ef51"
                    stroke="#0e0f0e"
                    strokeWidth="2"
                    style={{ cursor: "pointer", transition: "r 0.15s ease" }}
                    onMouseEnter={() => setHoveredPointIndex(idx)}
                    onMouseLeave={() => setHoveredPointIndex(null)}
                  />
                </g>
              ))}
            </svg>

            {/* Hover Tooltip Overlay */}
            {hoveredPointIndex !== null && points[hoveredPointIndex] && (
              <div style={{
                position: "absolute",
                top: "10px",
                right: "10px",
                background: "#1e201c",
                border: "1px solid #383a34",
                padding: "8px 14px",
                borderRadius: "8px",
                fontSize: "13px",
                color: "#f7f7f3",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}>
                <span style={{ color: "#888982" }}>{points[hoveredPointIndex].date}: </span>
                <strong style={{ color: "#a4ef51" }}>{formatMetricVal(points[hoveredPointIndex].rawVal, selectedChartMetric)}</strong>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Deterministic SEO Opportunities (NO AI) */}
      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
        <div className="card-header" style={{ marginBottom: "16px" }}>
          <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800 }}>SEO Opportunities (Search Console Signals)</h4>
          <p className="card-sub" style={{ fontSize: "13px", color: "#888982" }}>Generated dynamically from your real Search Console queries and rank metrics.</p>
        </div>

        {report?.opportunities && report.opportunities.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px" }}>
            {report.opportunities.map((opp) => (
              <div key={opp.id} style={{ background: "#191b17", border: "1px solid #2c2f29", borderRadius: "12px", padding: "18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <span style={{
                    fontSize: "11px",
                    fontWeight: 800,
                    padding: "3px 8px",
                    borderRadius: "6px",
                    textTransform: "uppercase",
                    background: opp.type === "low_ctr" ? "#3b2012" : opp.type === "striking_distance" ? "#182c3d" : "#2e153b",
                    color: opp.type === "low_ctr" ? "#f97316" : opp.type === "striking_distance" ? "#38bdf8" : "#c084fc",
                  }}>
                    {opp.type.replace("_", " ")}
                  </span>
                  <small style={{ color: "#888982", fontSize: "12px" }}>Pos #{opp.metrics.position.toFixed(1)}</small>
                </div>
                <h5 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: 700, color: "#f7f7f3" }}>{opp.title}</h5>
                <p style={{ margin: 0, fontSize: "13px", color: "#a5a69f", lineHeight: "1.5" }}>{opp.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="card-sub" style={{ color: "#888982" }}>No immediate keyword opportunities detected for the selected date range.</p>
        )}
      </div>

      {/* Two Column Section: Top Queries & Top Pages */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(460px, 1fr))", gap: "24px", marginTop: "24px" }}>

        {/* Top Queries Table */}
        <div className="console-section-card" style={{ padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
          <div className="flex-between" style={{ marginBottom: "16px" }}>
            <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, margin: 0 }}>Top Queries</h4>
            <input
              type="text"
              placeholder="Search queries..."
              value={querySearch}
              onChange={(e) => { setQuerySearch(e.target.value); setQueryPage(1); }}
              style={{
                background: "#191b17",
                border: "1px solid #2d2f2b",
                color: "#f7f7f3",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "13px",
                width: "160px",
              }}
            />
          </div>

          {isLoading ? (
            <p className="card-sub">Loading query performance...</p>
          ) : filteredQueries.length === 0 ? (
            <p className="card-sub">No queries found matching &quot;{querySearch}&quot;.</p>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ width: "100%", fontSize: "13px" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Query</th>
                      <th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>Imp.</th>
                      <th style={{ textAlign: "right" }}>CTR</th>
                      <th style={{ textAlign: "right" }}>Pos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedQueries.map((q) => (
                      <tr key={q.query}>
                        <td style={{ fontWeight: 600, color: "#f7f7f3" }}>{q.query}</td>
                        <td style={{ textAlign: "right", color: "#a4ef51", fontWeight: 700 }}>{q.clicks}</td>
                        <td style={{ textAlign: "right", color: "#a5a69f" }}>{q.impressions}</td>
                        <td style={{ textAlign: "right", color: "#a5a69f" }}>{(q.ctr * 100).toFixed(1)}%</td>
                        <td style={{ textAlign: "right", color: "#888982" }}>{q.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalQueryPages > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", fontSize: "12px", color: "#888982" }}>
                  <span>Page {queryPage} of {totalQueryPages}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      disabled={queryPage <= 1}
                      onClick={() => setQueryPage((p) => Math.max(1, p - 1))}
                      style={{ background: "#1a1c19", border: "1px solid #2d2f2b", color: "#f7f7f3", padding: "4px 10px", borderRadius: "4px", cursor: "pointer" }}
                    >
                      Prev
                    </button>
                    <button
                      disabled={queryPage >= totalQueryPages}
                      onClick={() => setQueryPage((p) => Math.min(totalQueryPages, p + 1))}
                      style={{ background: "#1a1c19", border: "1px solid #2d2f2b", color: "#f7f7f3", padding: "4px 10px", borderRadius: "4px", cursor: "pointer" }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Top Pages Table */}
        <div className="console-section-card" style={{ padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
          <div className="flex-between" style={{ marginBottom: "16px" }}>
            <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, margin: 0 }}>Top Pages</h4>
            <input
              type="text"
              placeholder="Search pages..."
              value={pageSearch}
              onChange={(e) => { setPageSearch(e.target.value); setPageNumber(1); }}
              style={{
                background: "#191b17",
                border: "1px solid #2d2f2b",
                color: "#f7f7f3",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "13px",
                width: "160px",
              }}
            />
          </div>

          {isLoading ? (
            <p className="card-sub">Loading page performance...</p>
          ) : filteredPages.length === 0 ? (
            <p className="card-sub">No pages found matching &quot;{pageSearch}&quot;.</p>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ width: "100%", fontSize: "13px" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>URL Path</th>
                      <th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>Imp.</th>
                      <th style={{ textAlign: "right" }}>CTR</th>
                      <th style={{ textAlign: "right" }}>Pos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedPages.map((p) => {
                      let cleanPath = p.page;
                      try { cleanPath = new URL(p.page).pathname; } catch { cleanPath = p.page; }
                      return (
                        <tr key={p.page}>
                          <td style={{ fontWeight: 600, color: "#f7f7f3" }} title={p.page}>{cleanPath || "/"}</td>
                          <td style={{ textAlign: "right", color: "#60a5fa", fontWeight: 700 }}>{p.clicks}</td>
                          <td style={{ textAlign: "right", color: "#a5a69f" }}>{p.impressions}</td>
                          <td style={{ textAlign: "right", color: "#a5a69f" }}>{(p.ctr * 100).toFixed(1)}%</td>
                          <td style={{ textAlign: "right", color: "#888982" }}>{p.position.toFixed(1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPagePages > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", fontSize: "12px", color: "#888982" }}>
                  <span>Page {pageNumber} of {totalPagePages}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      disabled={pageNumber <= 1}
                      onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                      style={{ background: "#1a1c19", border: "1px solid #2d2f2b", color: "#f7f7f3", padding: "4px 10px", borderRadius: "4px", cursor: "pointer" }}
                    >
                      Prev
                    </button>
                    <button
                      disabled={pageNumber >= totalPagePages}
                      onClick={() => setPageNumber((p) => Math.min(totalPagePages, p + 1))}
                      style={{ background: "#1a1c19", border: "1px solid #2d2f2b", color: "#f7f7f3", padding: "4px 10px", borderRadius: "4px", cursor: "pointer" }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      </div>

      {/* Breakdowns Section: Countries & Devices */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "24px", marginTop: "24px" }}>

        {/* Top Countries */}
        <div className="console-section-card" style={{ padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
          <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, marginBottom: "16px" }}>Top Countries</h4>
          {report?.countries && report.countries.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {report.countries.slice(0, 5).map((c) => {
                const maxClicks = Math.max(...report.countries.map((x) => x.clicks), 1);
                const pct = Math.round((c.clicks / maxClicks) * 100);
                return (
                  <div key={c.countryCode}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "4px" }}>
                      <span style={{ fontWeight: 600 }}>{c.country} ({c.countryCode.toUpperCase()})</span>
                      <span style={{ color: "#a4ef51", fontWeight: 700 }}>{c.clicks} clicks</span>
                    </div>
                    <div style={{ height: "6px", background: "#1f211d", borderRadius: "3px", overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: "#a4ef51", borderRadius: "3px" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="card-sub">No country breakdown returned by Search Console.</p>
          )}
        </div>

        {/* Devices */}
        <div className="console-section-card" style={{ padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
          <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, marginBottom: "16px" }}>Devices Breakdown</h4>
          {report?.devices && report.devices.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
              {["DESKTOP", "MOBILE", "TABLET"].map((devType) => {
                const devData = report.devices.find((d) => d.device.toUpperCase() === devType) || { clicks: 0, impressions: 0 };
                const totalDevClicks = report.devices.reduce((acc, d) => acc + d.clicks, 0) || 1;
                const share = Math.round((devData.clicks / totalDevClicks) * 100);
                return (
                  <div key={devType} style={{ background: "#191b17", border: "1px solid #2c2f29", borderRadius: "10px", padding: "14px", textAlign: "center" }}>
                    <small style={{ color: "#888982", fontSize: "11px", fontWeight: 800 }}>{devType}</small>
                    <div style={{ fontSize: "20px", fontWeight: 900, color: "#f7f7f3", margin: "6px 0 2px 0" }}>{share}%</div>
                    <span style={{ fontSize: "12px", color: "#a5a69f" }}>{devData.clicks} clicks</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="card-sub">No device breakdown returned by Search Console.</p>
          )}
        </div>

      </div>

      {/* Search Appearance Section (Conditional) */}
      {report?.searchAppearance && report.searchAppearance.length > 0 && (
        <div className="console-section-card" style={{ marginTop: "24px", padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
          <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, marginBottom: "16px" }}>Search Appearance</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
            {report.searchAppearance.map((sa) => (
              <div key={sa.appearance} style={{ background: "#191b17", border: "1px solid #2c2f29", borderRadius: "10px", padding: "14px" }}>
                <strong style={{ color: "#f7f7f3", fontSize: "13px" }}>{sa.appearance.replace(/_/g, " ")}</strong>
                <div style={{ color: "#a4ef51", fontSize: "16px", fontWeight: 800, marginTop: "4px" }}>{sa.clicks} clicks</div>
                <small style={{ color: "#888982" }}>{sa.impressions} impressions</small>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indexing Overview & Coverage */}
      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
        <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, marginBottom: "16px" }}>Indexing &amp; Coverage Overview</h4>
        {report?.indexingOverview ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <div style={{ background: "#172b1a", border: "1px solid #224a27", borderRadius: "10px", padding: "14px" }}>
              <span style={{ color: "#a4ef51", fontSize: "12px", fontWeight: 800 }}>Indexed Pages</span>
              <div style={{ fontSize: "24px", fontWeight: 900, color: "#f7f7f3" }}>{report.indexingOverview.indexedPages}</div>
            </div>
            <div style={{ background: "#2b2117", border: "1px solid #4a3422", borderRadius: "10px", padding: "14px" }}>
              <span style={{ color: "#f97316", fontSize: "12px", fontWeight: 800 }}>Not Indexed</span>
              <div style={{ fontSize: "24px", fontWeight: 900, color: "#f7f7f3" }}>{report.indexingOverview.notIndexed}</div>
            </div>
            <div style={{ background: "#2b1717", border: "1px solid #4a2222", borderRadius: "10px", padding: "14px" }}>
              <span style={{ color: "#ef4444", fontSize: "12px", fontWeight: 800 }}>Coverage Errors</span>
              <div style={{ fontSize: "24px", fontWeight: 900, color: "#f7f7f3" }}>{report.indexingOverview.errors}</div>
            </div>
            <div style={{ background: "#1c1d1a", border: "1px solid #2c2e29", borderRadius: "10px", padding: "14px" }}>
              <span style={{ color: "#888982", fontSize: "12px", fontWeight: 800 }}>Excluded</span>
              <div style={{ fontSize: "24px", fontWeight: 900, color: "#f7f7f3" }}>{report.indexingOverview.excluded}</div>
            </div>
          </div>
        ) : (
          <p className="card-sub" style={{ color: "#888982" }}>No indexing errors available.</p>
        )}
      </div>

      {/* Sitemaps Inspection Section */}
      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px", background: "#141513", border: "1px solid #232521", borderRadius: "16px" }}>
        <h4 className="card-title" style={{ fontSize: "16px", fontWeight: 800, marginBottom: "16px" }}>Sitemaps</h4>
        {report?.sitemaps && report.sitemaps.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Sitemap Path</th>
                  <th style={{ textAlign: "left" }}>Last Downloaded</th>
                  <th style={{ textAlign: "center" }}>Status</th>
                  <th style={{ textAlign: "right" }}>Submitted</th>
                  <th style={{ textAlign: "right" }}>Indexed</th>
                </tr>
              </thead>
              <tbody>
                {report.sitemaps.map((s) => (
                  <tr key={s.path}>
                    <td style={{ fontWeight: 600, color: "#f7f7f3" }}>{s.path}</td>
                    <td style={{ color: "#888982" }}>{s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString() : "Pending"}</td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{
                        background: s.hasErrors ? "#3b1c1c" : s.isWarnings ? "#3b2b1c" : "#17381e",
                        color: s.hasErrors ? "#ef4444" : s.isWarnings ? "#f97316" : "#a4ef51",
                        padding: "2px 8px",
                        borderRadius: "6px",
                        fontSize: "11px",
                        fontWeight: 800,
                      }}>
                        {s.hasErrors ? "Errors" : s.isWarnings ? "Warnings" : "Success"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", color: "#a5a69f" }}>{s.submitted}</td>
                    <td style={{ textAlign: "right", color: "#a4ef51", fontWeight: 700 }}>{s.indexed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <p className="card-sub" style={{ margin: "0 0 12px 0" }}>No sitemaps found in Google Search Console for this property.</p>
            <small style={{ color: "#888982" }}>Ensure <code style={{ color: "#a4ef51" }}>/sitemap.xml</code> is submitted in Search Console.</small>
          </div>
        )}
      </div>

    </div>
  );
}
