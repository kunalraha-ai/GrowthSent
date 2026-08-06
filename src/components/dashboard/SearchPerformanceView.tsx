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

  // Layout constants for SVG chart (kept outside useMemo so they're always available)
  const svgWidth = 840;
  const svgHeight = 260;
  const marginLeft = 50;
  const marginRight = 20;
  const marginBottom = 220;

  // Memoize all SVG Chart computations for 60 FPS performance and strict hook ordering
  const chartData = useMemo(() => {
    const series = report?.dailySeries || [];
    if (series.length === 0) return { points: [] as { x: number; y: number; date: string; rawVal: number }[], yTicks: [] as { y: number; val: number }[], xDateTicks: [] as { x: number; y: number; date: string; rawVal: number }[], svgPathD: "", areaPathD: "" };

    const marginTop = 30;
    const plotWidth = svgWidth - marginLeft - marginRight;
    const plotHeight = marginBottom - marginTop;

    const metricValues = series.map((d) => {
      if (selectedChartMetric === "clicks") return d.clicks;
      if (selectedChartMetric === "impressions") return d.impressions;
      if (selectedChartMetric === "ctr") return d.ctr * 100;
      return d.position;
    });

    const maxVal = Math.max(...metricValues, 3);
    const minVal = selectedChartMetric === "position" ? Math.min(...metricValues, 1) : 0;
    const valRange = maxVal - minVal || 1;

    const yTicks = [0, 1, 2, 3].map((step) => {
      const ratio = step / 3;
      const y = marginBottom - ratio * plotHeight;
      const val = selectedChartMetric === "position"
        ? maxVal - ratio * valRange
        : minVal + ratio * valRange;
      return { y, val };
    });

    const points = series.map((d, idx) => {
      const x = marginLeft + (idx / Math.max(series.length - 1, 1)) * plotWidth;
      const rawVal = selectedChartMetric === "clicks" ? d.clicks : selectedChartMetric === "impressions" ? d.impressions : selectedChartMetric === "ctr" ? d.ctr * 100 : d.position;
      const normalized = selectedChartMetric === "position" ? (maxVal - rawVal) / valRange : (rawVal - minVal) / valRange;
      const y = marginBottom - normalized * plotHeight;
      return { x, y, date: d.date, rawVal };
    });

    const svgPathD = points.length > 0
      ? points.reduce((acc, pt, i) => (i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`), "")
      : "";

    const areaPathD = points.length > 0
      ? `${svgPathD} L ${points[points.length - 1].x} ${marginBottom} L ${points[0].x} ${marginBottom} Z`
      : "";

    const count = Math.min(series.length, 5);
    const xDateTicks: { x: number; y: number; date: string; rawVal: number }[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1)) * (series.length - 1));
      const pt = points[idx];
      if (pt) xDateTicks.push(pt);
    }

    return { points, yTicks, xDateTicks, svgPathD, areaPathD };
  }, [report?.dailySeries, selectedChartMetric]);

  const { points, yTicks, xDateTicks, svgPathD, areaPathD } = chartData;

  // Render Not Connected State matching Overview style
  if (!isGscConnected) {
    return (
      <div className="search-performance-view">
        <div className="console-title"><h3 className="title-text">Search Performance</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "24px", padding: "48px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 12px 0" }}>Connect Google Search Console</h3>
          <p className="card-sub" style={{ maxWidth: "520px", margin: "0 auto 24px auto" }}>
            Search clicks, impressions, queries, CTR, and positions are shown only after a real Google Search Console connection is authorized.
          </p>
          <button className="primary-btn" onClick={() => onNavigateTab("gsc")}>Connect Google Search Console →</button>
        </div>
      </div>
    );
  }

  const series = report?.dailySeries || [];
  const summary = report?.summary || { totalClicks: 0, totalImpressions: 0, avgCtr: 0, avgPosition: 0 };

  const formatMetricVal = (val: number, type: ActiveChartMetric) => {
    if (type === "clicks" || type === "impressions") return Math.round(val).toLocaleString();
    if (type === "ctr") return `${val.toFixed(1)}%`;
    return `#${val.toFixed(1)}`;
  };

  return (
    <div className="search-performance-view">
      {/* Header Controls matching Overview style (NO CONNECTED BUTTON) */}
      <div className="console-title flex-between">
        <div>
          <h3 className="title-text">Search Performance</h3>
          {report?.siteUrl && <small className="text-muted" style={{ fontSize: "12px" }}>Property: {report.siteUrl}</small>}
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {/* Date Selector Pills */}
          <div style={{ background: "#e5e7eb", padding: "3px", borderRadius: "8px", display: "flex", gap: "2px" }}>
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
                  background: days === item.val ? "#171817" : "transparent",
                  color: days === item.val ? "#ffffff" : "#4b5563",
                  border: "none",
                  padding: "5px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: days === item.val ? 700 : 500,
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
        </div>
      </div>

      {error && (
        <div role="alert" style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px", color: "#b42318", background: "#fef3f2", border: "1px solid #fecdca", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{error}</span>
          <button onClick={fetchReport} className="secondary-btn" style={{ fontSize: "12px", padding: "3px 8px" }}>Retry</button>
        </div>
      )}

      {/* KPI Cards (4 metrics matching Overview style) */}
      <div className="metrics-grid" style={{ marginTop: "20px" }}>
        <div className="metric-card">
          <p className="metric-label">Total Clicks</p>
          <b className="metric-val">{isLoading ? "..." : summary.totalClicks.toLocaleString()}</b>
          <span className="metric-sub text-muted">Last {days} days</span>
        </div>

        <div className="metric-card">
          <p className="metric-label">Total Impressions</p>
          <b className="metric-val">{isLoading ? "..." : summary.totalImpressions.toLocaleString()}</b>
          <span className="metric-sub text-muted">Search visibility</span>
        </div>

        <div className="metric-card">
          <p className="metric-label">Average CTR</p>
          <b className="metric-val">{isLoading ? "..." : `${(summary.avgCtr * 100).toFixed(1)}%`}</b>
          <span className="metric-sub text-muted">Click-through rate</span>
        </div>

        <div className="metric-card">
          <p className="metric-label">Average Position</p>
          <b className="metric-val">{isLoading ? "..." : summary.avgPosition ? summary.avgPosition.toFixed(1) : "—"}</b>
          <span className="metric-sub text-muted">Average search rank</span>
        </div>
      </div>

      {/* Performance Chart Card with Grid Lines & Axis Numbers (GSC style) */}
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header flex-between">
          <h4 className="card-title">Performance Over Time</h4>

          {/* Metric Selector Tabs */}
          <div style={{ display: "flex", gap: "4px", background: "#f3f4f1", padding: "3px", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
            {[
              { key: "clicks", label: "Clicks" },
              { key: "impressions", label: "Impressions" },
              { key: "ctr", label: "CTR" },
              { key: "position", label: "Avg Position" },
            ].map((m) => (
              <button
                key={m.key}
                onClick={() => setSelectedChartMetric(m.key as ActiveChartMetric)}
                style={{
                  background: selectedChartMetric === m.key ? "#a4ef51" : "transparent",
                  color: selectedChartMetric === m.key ? "#0e0f0e" : "#4b5563",
                  border: "none",
                  padding: "5px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: selectedChartMetric === m.key ? 800 : 500,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* GSC-Style SVG Chart Container */}
        <div style={{ padding: "20px" }}>
          {isLoading ? (
            <p className="card-sub" style={{ textAlign: "center", padding: "40px" }}>Loading timeline data...</p>
          ) : series.length === 0 ? (
            <p className="card-sub" style={{ textAlign: "center", padding: "40px" }}>No timeline data returned for the selected range.</p>
          ) : (
            <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: "100%", height: "260px", overflow: "visible" }}>
                <defs>
                  <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a4ef51" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#a4ef51" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Metric Title Label at Top-Left of Chart Grid */}
                <text x={marginLeft} y="18" fill="#6b7280" fontSize="12" fontWeight="700" textAnchor="start">
                  {selectedChartMetric === "clicks" ? "Clicks" : selectedChartMetric === "impressions" ? "Impressions" : selectedChartMetric === "ctr" ? "CTR" : "Average position"}
                </text>

                {/* Horizontal Grid Lines & Y-Axis Number Labels */}
                {yTicks.map((t, idx) => (
                  <g key={idx}>
                    <line
                      x1={marginLeft}
                      y1={t.y}
                      x2={svgWidth - marginRight}
                      y2={t.y}
                      stroke="#e5e7eb"
                      strokeWidth="1"
                      strokeDasharray={idx === 0 ? "none" : "3 3"}
                    />
                    <text x={marginLeft - 8} y={t.y + 4} textAnchor="end" fontSize="11" fill="#9ca3af" fontWeight="600">
                      {selectedChartMetric === "ctr" ? `${t.val.toFixed(1)}%` : selectedChartMetric === "position" ? t.val.toFixed(1) : Math.round(t.val).toLocaleString()}
                    </text>
                  </g>
                ))}

                {/* Area Fill */}
                <path d={areaPathD} fill="url(#chartGradient)" />

                {/* Main Line */}
                <path d={svgPathD} fill="none" stroke="#171817" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

                {/* Interactive Data Points */}
                {points.map((pt, idx) => (
                  <circle
                    key={pt.date}
                    cx={pt.x}
                    cy={pt.y}
                    r={hoveredPointIndex === idx ? "6" : "3.5"}
                    fill="#a4ef51"
                    stroke="#171817"
                    strokeWidth="2"
                    style={{ cursor: "pointer", transition: "r 0.15s ease" }}
                    onMouseEnter={() => setHoveredPointIndex(idx)}
                    onMouseLeave={() => setHoveredPointIndex(null)}
                  />
                ))}

                {/* X-Axis Date Ticks at Bottom */}
                {xDateTicks.map((tick) => (
                  <text key={tick.date} x={tick.x} y={marginBottom + 20} textAnchor="middle" fontSize="11" fill="#6b7280" fontWeight="500">
                    {tick.date}
                  </text>
                ))}
              </svg>

              {/* Hover Tooltip Overlay */}
              {hoveredPointIndex !== null && points[hoveredPointIndex] && (
                <div style={{
                  position: "absolute",
                  top: "10px",
                  right: "10px",
                  background: "#171817",
                  color: "#ffffff",
                  padding: "6px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                }}>
                  <span style={{ color: "#9ca3af" }}>{points[hoveredPointIndex].date}: </span>
                  <strong style={{ color: "#a4ef51" }}>{formatMetricVal(points[hoveredPointIndex].rawVal, selectedChartMetric)}</strong>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SEO Opportunities */}
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header">
          <h4 className="card-title">SEO Opportunities (Search Console Signals)</h4>
          <p className="card-sub" style={{ marginTop: "4px" }}>Generated dynamically from your real Search Console queries and rank metrics.</p>
        </div>

        <div style={{ padding: "20px" }}>
          {report?.opportunities && report.opportunities.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
              {report.opportunities.map((opp) => (
                <div key={opp.id} style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <span style={{
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "4px",
                      textTransform: "uppercase",
                      background: opp.type === "low_ctr" ? "#fef3c7" : opp.type === "striking_distance" ? "#e0f2fe" : "#f3e8ff",
                      color: opp.type === "low_ctr" ? "#b45309" : opp.type === "striking_distance" ? "#0369a1" : "#6b21a8",
                    }}>
                      {opp.type.replace("_", " ")}
                    </span>
                    <small className="text-muted" style={{ fontSize: "12px" }}>Pos #{opp.metrics.position.toFixed(1)}</small>
                  </div>
                  <h5 style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: 700 }}>{opp.title}</h5>
                  <p className="card-sub" style={{ margin: 0, fontSize: "13px", lineHeight: "1.5" }}>{opp.description}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="card-sub">No immediate keyword opportunities detected for the selected date range.</p>
          )}
        </div>
      </div>

      {/* Two Column Section: Top Queries & Top Pages */}
      <div className="overview-two-col" style={{ marginTop: "24px" }}>

        {/* Top Queries Table */}
        <div className="console-section-card">
          <div className="card-header flex-between">
            <h4 className="card-title">Top Queries</h4>
            <input
              className="form-input"
              type="text"
              placeholder="Search queries..."
              value={querySearch}
              onChange={(e) => { setQuerySearch(e.target.value); setQueryPage(1); }}
              style={{ width: "160px", padding: "4px 10px", fontSize: "12px" }}
            />
          </div>

          {isLoading ? (
            <p className="card-sub" style={{ padding: "20px" }}>Loading query performance...</p>
          ) : filteredQueries.length === 0 ? (
            <p className="card-sub" style={{ padding: "20px" }}>No queries found matching &quot;{querySearch}&quot;.</p>
          ) : (
            <div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>Imp.</th>
                      <th style={{ textAlign: "right" }}>CTR</th>
                      <th style={{ textAlign: "right" }}>Pos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedQueries.map((q) => (
                      <tr key={q.query}>
                        <td style={{ fontWeight: 600 }}>{q.query}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{q.clicks}</td>
                        <td style={{ textAlign: "right" }}>{q.impressions}</td>
                        <td style={{ textAlign: "right" }}>{(q.ctr * 100).toFixed(1)}%</td>
                        <td style={{ textAlign: "right", color: "#6b7280" }}>{q.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalQueryPages > 1 && (
                <div className="flex-between" style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", fontSize: "12px" }}>
                  <span className="text-muted">Page {queryPage} of {totalQueryPages}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      disabled={queryPage <= 1}
                      onClick={() => setQueryPage((p) => Math.max(1, p - 1))}
                      className="secondary-btn"
                      style={{ fontSize: "12px", padding: "3px 8px" }}
                    >
                      Prev
                    </button>
                    <button
                      disabled={queryPage >= totalQueryPages}
                      onClick={() => setQueryPage((p) => Math.min(totalQueryPages, p + 1))}
                      className="secondary-btn"
                      style={{ fontSize: "12px", padding: "3px 8px" }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Top Pages Table */}
        <div className="console-section-card">
          <div className="card-header flex-between">
            <h4 className="card-title">Top Pages</h4>
            <input
              className="form-input"
              type="text"
              placeholder="Search pages..."
              value={pageSearch}
              onChange={(e) => { setPageSearch(e.target.value); setPageNumber(1); }}
              style={{ width: "160px", padding: "4px 10px", fontSize: "12px" }}
            />
          </div>

          {isLoading ? (
            <p className="card-sub" style={{ padding: "20px" }}>Loading page performance...</p>
          ) : filteredPages.length === 0 ? (
            <p className="card-sub" style={{ padding: "20px" }}>No pages found matching &quot;{pageSearch}&quot;.</p>
          ) : (
            <div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>URL Path</th>
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
                          <td style={{ fontWeight: 600 }} title={p.page}>{cleanPath || "/"}</td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>{p.clicks}</td>
                          <td style={{ textAlign: "right" }}>{p.impressions}</td>
                          <td style={{ textAlign: "right" }}>{(p.ctr * 100).toFixed(1)}%</td>
                          <td style={{ textAlign: "right", color: "#6b7280" }}>{p.position.toFixed(1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPagePages > 1 && (
                <div className="flex-between" style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", fontSize: "12px" }}>
                  <span className="text-muted">Page {pageNumber} of {totalPagePages}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      disabled={pageNumber <= 1}
                      onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                      className="secondary-btn"
                      style={{ fontSize: "12px", padding: "3px 8px" }}
                    >
                      Prev
                    </button>
                    <button
                      disabled={pageNumber >= totalPagePages}
                      onClick={() => setPageNumber((p) => Math.min(totalPagePages, p + 1))}
                      className="secondary-btn"
                      style={{ fontSize: "12px", padding: "3px 8px" }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Breakdowns Section: Countries & Devices */}
      <div className="overview-two-col" style={{ marginTop: "24px" }}>

        {/* Top Countries */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Top Countries</h4></div>
          <div style={{ padding: "20px" }}>
            {report?.countries && report.countries.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {report.countries.slice(0, 5).map((c) => {
                  const maxClicks = Math.max(...report.countries.map((x) => x.clicks), 1);
                  const pct = Math.round((c.clicks / maxClicks) * 100);
                  return (
                    <div key={c.countryCode}>
                      <div className="flex-between" style={{ fontSize: "13px", marginBottom: "4px" }}>
                        <span style={{ fontWeight: 600 }}>{c.country} ({c.countryCode.toUpperCase()})</span>
                        <span style={{ fontWeight: 700 }}>{c.clicks} clicks</span>
                      </div>
                      <div style={{ height: "6px", background: "#f3f4f1", borderRadius: "3px", overflow: "hidden" }}>
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
        </div>

        {/* Devices */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Devices Breakdown</h4></div>
          <div style={{ padding: "20px" }}>
            {report?.devices && report.devices.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                {["DESKTOP", "MOBILE", "TABLET"].map((devType) => {
                  const devData = report.devices.find((d) => d.device.toUpperCase() === devType) || { clicks: 0, impressions: 0 };
                  const totalDevClicks = report.devices.reduce((acc, d) => acc + d.clicks, 0) || 1;
                  const share = Math.round((devData.clicks / totalDevClicks) * 100);
                  return (
                    <div key={devType} style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "14px", textAlign: "center" }}>
                      <small className="text-muted" style={{ fontSize: "11px", fontWeight: 700 }}>{devType}</small>
                      <div style={{ fontSize: "20px", fontWeight: 800, margin: "4px 0" }}>{share}%</div>
                      <span className="text-muted" style={{ fontSize: "12px" }}>{devData.clicks} clicks</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="card-sub">No device breakdown returned by Search Console.</p>
            )}
          </div>
        </div>

      </div>

      {/* Sitemaps Inspection Section */}
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header"><h4 className="card-title">Sitemaps</h4></div>
        <div style={{ padding: "20px" }}>
          {report?.sitemaps && report.sitemaps.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sitemap Path</th>
                    <th>Last Downloaded</th>
                    <th style={{ textAlign: "center" }}>Status</th>
                    <th style={{ textAlign: "right" }}>Submitted</th>
                    <th style={{ textAlign: "right" }}>Indexed</th>
                  </tr>
                </thead>
                <tbody>
                  {report.sitemaps.map((s) => (
                    <tr key={s.path}>
                      <td style={{ fontWeight: 600 }}>{s.path}</td>
                      <td className="text-muted">{s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString() : "Pending"}</td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{
                          background: s.hasErrors ? "#fef2f2" : s.isWarnings ? "#fffbe6" : "#f0fdf4",
                          color: s.hasErrors ? "#dc2626" : s.isWarnings ? "#d97706" : "#16a34a",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: 700,
                        }}>
                          {s.hasErrors ? "Errors" : s.isWarnings ? "Warnings" : "Success"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>{s.submitted}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{s.indexed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="card-sub">No sitemaps found in Google Search Console for this property.</p>
          )}
        </div>
      </div>

    </div>
  );
}
