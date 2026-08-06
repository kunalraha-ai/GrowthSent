import React, { useEffect, useMemo, useState } from "react";

interface AnalyticsViewProps {
  activeSite?: string;
  websiteId: string | null;
  onNavigateTab?: (tab: string) => void;
}

interface Ga4FullReportData {
  connected: boolean;
  propertyId: string;
  propertyDisplayName?: string;
  lastSynced: string;
  dateRange: {
    days: number;
    startDate: string;
    endDate: string;
  };
  kpis: {
    users: { current: number; previous: number; pctChange: number; series: number[] };
    sessions: { current: number; previous: number; pctChange: number; series: number[] };
    engagedSessions: { current: number; previous: number; pctChange: number; series: number[] };
    engagementRate: { current: number; previous: number; pctChange: number; series: number[] };
    avgEngagementTimeSec: { current: number; previous: number; pctChange: number; series: number[] };
    eventCount: { current: number; previous: number; pctChange: number; series: number[] };
  };
  dailySeries: Array<{
    date: string;
    users: number;
    sessions: number;
    pageViews: number;
    engagedSessions: number;
    eventCount: number;
  }>;
  trafficSources: Array<{
    channel: string;
    users: number;
    sessions: number;
    engagementRate: number;
  }>;
  landingPages: Array<{
    pagePath: string;
    users: number;
    sessions: number;
    bounceRate: number;
    engagementRate: number;
    avgEngagementTimeSec: number;
  }>;
  countries: Array<{
    country: string;
    countryCode?: string;
    users: number;
    sessions: number;
  }>;
  devices: {
    categories: Array<{ device: string; users: number; percentage: number }>;
    browsers: Array<{ browser: string; users: number }>;
    os: Array<{ os: string; users: number }>;
  };
  realtime?: {
    activeUsers: number;
    activePages: Array<{ pagePath: string; activeUsers: number }>;
    activeCountries: Array<{ country: string; activeUsers: number }>;
    activeDevices: Array<{ device: string; activeUsers: number }>;
  };
  events: Array<{
    eventName: string;
    count: number;
    users: number;
  }>;
  conversions: Array<{
    eventName: string;
    count: number;
    rate: number;
  }>;
  audience: {
    newUsers: number;
    returningUsers: number;
    avgSessionDurationSec: number;
    sessionsPerUser: number;
  };
  seoInsights: Array<{
    id: string;
    type: "poor_engagement" | "high_bounce" | "growing_source" | "declining_traffic" | "low_conversion";
    title: string;
    description: string;
    metricLabel: string;
  }>;
}

type ActiveChartMetric = "users" | "sessions" | "pageViews" | "engagedSessions" | "eventCount";

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function Sparkline({ data, color = "#a4ef51" }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) return null;
  const width = 80;
  const height = 24;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data
    .map((val, idx) => {
      const x = (idx / (data.length - 1)) * width;
      const y = height - ((val - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

export function AnalyticsView({ activeSite, websiteId, onNavigateTab }: AnalyticsViewProps) {
  const [days, setDays] = useState<number>(28);
  const [report, setReport] = useState<Ga4FullReportData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notConnected, setNotConnected] = useState(false);
  const [noPropertySelected, setNoPropertySelected] = useState(false);

  const [selectedChartMetric, setSelectedChartMetric] = useState<ActiveChartMetric>("users");

  const [pageSearch, setPageSearch] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const itemsPerPage = 10;

  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  const fetchReport = async (isBackground = false) => {
    if (!websiteId) {
      setReport(null);
      return;
    }
    if (!isBackground) setIsLoading(true);
    setError("");
    setNotConnected(false);
    setNoPropertySelected(false);
    try {
      const response = await fetch(`/api/v1/ga4-full-report?websiteId=${websiteId}&days=${days}`);
      const data = await response.json();
      if (!response.ok) {
        const message: string = data.error?.message || "Unable to load Google Analytics data.";
        if (/not connected/i.test(message)) setNotConnected(true);
        else if (/no google analytics property/i.test(message)) setNoPropertySelected(true);
        else setError(message);
        setReport(null);
        return;
      }
      setReport(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Google Analytics data.");
      setReport(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReport(false);
  }, [websiteId, days]);

  useEffect(() => {
    if (!websiteId || notConnected || noPropertySelected) return;
    const interval = setInterval(() => {
      fetchReport(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [websiteId, days, notConnected, noPropertySelected]);

  const filteredPages = useMemo(() => {
    if (!report?.landingPages) return [];
    if (!pageSearch.trim()) return report.landingPages;
    const term = pageSearch.toLowerCase();
    return report.landingPages.filter((p) => p.pagePath.toLowerCase().includes(term));
  }, [report?.landingPages, pageSearch]);

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

  // Memoize all SVG Chart computations for 60 FPS performance
  const chartData = useMemo(() => {
    const series = report?.dailySeries || [];
    if (series.length === 0) return { points: [] as { x: number; y: number; date: string; rawVal: number }[], yTicks: [] as { y: number; val: number }[], xDateTicks: [] as { x: number; y: number; date: string; rawVal: number }[], svgPathD: "", areaPathD: "" };

    const marginTop = 30;
    const plotWidth = svgWidth - marginLeft - marginRight;
    const plotHeight = marginBottom - marginTop;

    const metricValues = series.map((d) => {
      if (selectedChartMetric === "users") return d.users;
      if (selectedChartMetric === "sessions") return d.sessions;
      if (selectedChartMetric === "pageViews") return d.pageViews;
      if (selectedChartMetric === "engagedSessions") return d.engagedSessions;
      return d.eventCount;
    });

    const maxVal = Math.max(...metricValues, 3);
    const minVal = 0;
    const valRange = maxVal - minVal || 1;

    const yTicks = [0, 1, 2, 3].map((step) => {
      const ratio = step / 3;
      const y = marginBottom - ratio * plotHeight;
      const val = minVal + ratio * valRange;
      return { y, val };
    });

    const points = series.map((d, idx) => {
      const x = marginLeft + (idx / Math.max(series.length - 1, 1)) * plotWidth;
      const rawVal = selectedChartMetric === "users" ? d.users : selectedChartMetric === "sessions" ? d.sessions : selectedChartMetric === "pageViews" ? d.pageViews : selectedChartMetric === "engagedSessions" ? d.engagedSessions : d.eventCount;
      const y = marginBottom - ((rawVal - minVal) / valRange) * plotHeight;
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

  if (!websiteId) {
    return (
      <div className="analytics-view">
        <div className="console-title"><h3 className="title-text">Google Analytics 4</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}>
          <p className="card-sub">Select or add a website to view its Google Analytics data.</p>
        </div>
      </div>
    );
  }

  if (notConnected) {
    return (
      <div className="analytics-view">
        <div className="console-title"><h3 className="title-text">Google Analytics 4</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "24px", padding: "48px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 12px 0" }}>Connect Google Analytics</h3>
          <p className="card-sub" style={{ maxWidth: "520px", margin: "0 auto 24px auto" }}>
            Google Analytics 4 isn&apos;t connected for this website yet. Connect your Google account to unlock real user traffic, active sessions, landing pages, and engagement analytics.
          </p>
          {onNavigateTab && <button className="primary-btn" onClick={() => onNavigateTab("ga")}>Connect Google Analytics →</button>}
        </div>
      </div>
    );
  }

  if (noPropertySelected) {
    return (
      <div className="analytics-view">
        <div className="console-title"><h3 className="title-text">Google Analytics 4</h3></div>
        <div className="console-section-card empty-state-card" style={{ marginTop: "24px", padding: "48px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 12px 0" }}>Select a GA4 Property</h3>
          <p className="card-sub" style={{ maxWidth: "520px", margin: "0 auto 24px auto" }}>
            Google Analytics is connected, but no GA4 property has been selected yet. Select a property to start displaying real analytics data.
          </p>
          {onNavigateTab && <button className="primary-btn" onClick={() => onNavigateTab("ga")}>Select GA4 Property →</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="analytics-view">
      {/* Header Controls matching Overview style */}
      <div className="console-title flex-between">
        <div>
          <h3 className="title-text">Google Analytics 4</h3>
          {report?.propertyDisplayName && <small className="text-muted" style={{ fontSize: "12px" }}>Property: {report.propertyDisplayName} ({report.propertyId})</small>}
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

      {/* Realtime Live Users Banner */}
      {report?.realtime && (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "16px 20px", background: "#f0fdf4", border: "1px solid #bbf7d0", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", background: "#16a34a", color: "#ffffff", padding: "3px 10px", borderRadius: "12px", fontWeight: 800 }}>
              ● REALTIME LIVE
            </span>
            <strong style={{ fontSize: "16px", color: "#14532d" }}>
              {report.realtime.activeUsers} active user{report.realtime.activeUsers === 1 ? "" : "s"} right now
            </strong>
          </div>
          {report.realtime.activePages.length > 0 && (
            <span style={{ fontSize: "13px", color: "#166534" }}>
              Top active page: <strong>{report.realtime.activePages[0].pagePath}</strong> ({report.realtime.activePages[0].activeUsers} users)
            </span>
          )}
        </div>
      )}

      {/* 6 KPI Cards Grid */}
      <div className="metrics-grid" style={{ marginTop: "20px" }}>
        {/* 1. Users */}
        <div className="metric-card">
          <div className="flex-between">
            <p className="metric-label">Active Users</p>
            {kpis?.users && <Sparkline data={kpis.users.series} />}
          </div>
          <b className="metric-val">{isLoading ? "..." : (kpis?.users.current ?? 0).toLocaleString()}</b>
          <div className="flex-between" style={{ marginTop: "4px" }}>
            <span className="metric-sub text-muted">vs previous period</span>
            {kpis?.users && (
              <span style={{ fontSize: "12px", fontWeight: 700, color: kpis.users.pctChange >= 0 ? "#16a34a" : "#dc2626" }}>
                {kpis.users.pctChange >= 0 ? `+${kpis.users.pctChange}%` : `${kpis.users.pctChange}%`}
              </span>
            )}
          </div>
        </div>

        {/* 2. Sessions */}
        <div className="metric-card">
          <div className="flex-between">
            <p className="metric-label">Sessions</p>
            {kpis?.sessions && <Sparkline data={kpis.sessions.series} />}
          </div>
          <b className="metric-val">{isLoading ? "..." : (kpis?.sessions.current ?? 0).toLocaleString()}</b>
          <div className="flex-between" style={{ marginTop: "4px" }}>
            <span className="metric-sub text-muted">Total visits</span>
            {kpis?.sessions && (
              <span style={{ fontSize: "12px", fontWeight: 700, color: kpis.sessions.pctChange >= 0 ? "#16a34a" : "#dc2626" }}>
                {kpis.sessions.pctChange >= 0 ? `+${kpis.sessions.pctChange}%` : `${kpis.sessions.pctChange}%`}
              </span>
            )}
          </div>
        </div>

        {/* 3. Engaged Sessions */}
        <div className="metric-card">
          <div className="flex-between">
            <p className="metric-label">Engaged Sessions</p>
            {kpis?.engagedSessions && <Sparkline data={kpis.engagedSessions.series} />}
          </div>
          <b className="metric-val">{isLoading ? "..." : (kpis?.engagedSessions.current ?? 0).toLocaleString()}</b>
          <div className="flex-between" style={{ marginTop: "4px" }}>
            <span className="metric-sub text-muted">Qualified visits</span>
            {kpis?.engagedSessions && (
              <span style={{ fontSize: "12px", fontWeight: 700, color: kpis.engagedSessions.pctChange >= 0 ? "#16a34a" : "#dc2626" }}>
                {kpis.engagedSessions.pctChange >= 0 ? `+${kpis.engagedSessions.pctChange}%` : `${kpis.engagedSessions.pctChange}%`}
              </span>
            )}
          </div>
        </div>

        {/* 4. Engagement Rate */}
        <div className="metric-card">
          <p className="metric-label">Engagement Rate</p>
          <b className="metric-val">{isLoading ? "..." : `${((kpis?.engagementRate.current ?? 0) * 100).toFixed(1)}%`}</b>
          <div className="flex-between" style={{ marginTop: "4px" }}>
            <span className="metric-sub text-muted">Engaged session ratio</span>
            {kpis?.engagementRate && (
              <span style={{ fontSize: "12px", fontWeight: 700, color: kpis.engagementRate.pctChange >= 0 ? "#16a34a" : "#dc2626" }}>
                {kpis.engagementRate.pctChange >= 0 ? `+${kpis.engagementRate.pctChange}%` : `${kpis.engagementRate.pctChange}%`}
              </span>
            )}
          </div>
        </div>

        {/* 5. Avg Engagement Time */}
        <div className="metric-card">
          <p className="metric-label">Avg Engagement Time</p>
          <b className="metric-val">{isLoading ? "..." : formatDuration(kpis?.avgEngagementTimeSec.current ?? 0)}</b>
          <span className="metric-sub text-muted">Active user duration</span>
        </div>

        {/* 6. Event Count */}
        <div className="metric-card">
          <div className="flex-between">
            <p className="metric-label">Event Count</p>
            {kpis?.eventCount && <Sparkline data={kpis.eventCount.series} />}
          </div>
          <b className="metric-val">{isLoading ? "..." : (kpis?.eventCount.current ?? 0).toLocaleString()}</b>
          <span className="metric-sub text-muted">Total triggered events</span>
        </div>
      </div>

      {/* Traffic Overview Chart Card with Grid Lines & Axis Numbers (GSC style) */}
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header flex-between">
          <h4 className="card-title">Traffic Overview</h4>

          {/* Metric Selector Tabs */}
          <div style={{ display: "flex", gap: "4px", background: "#f3f4f1", padding: "3px", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
            {[
              { key: "users", label: "Users" },
              { key: "sessions", label: "Sessions" },
              { key: "pageViews", label: "Page Views" },
              { key: "engagedSessions", label: "Engaged Sessions" },
              { key: "eventCount", label: "Event Count" },
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
            <p className="card-sub" style={{ textAlign: "center", padding: "40px" }}>Loading Google Analytics timeline...</p>
          ) : series.length === 0 ? (
            <p className="card-sub" style={{ textAlign: "center", padding: "40px" }}>No timeline data returned for the selected range.</p>
          ) : (
            <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: "100%", height: "260px", overflow: "visible" }}>
                <defs>
                  <linearGradient id="ga4Gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a4ef51" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#a4ef51" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Metric Title Label at Top-Left of Chart Grid */}
                <text x={marginLeft} y="18" fill="#6b7280" fontSize="12" fontWeight="700" textAnchor="start">
                  {selectedChartMetric === "users" ? "Active Users" : selectedChartMetric === "sessions" ? "Sessions" : selectedChartMetric === "pageViews" ? "Page Views" : selectedChartMetric === "engagedSessions" ? "Engaged Sessions" : "Event Count"}
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
                      {Math.round(t.val).toLocaleString()}
                    </text>
                  </g>
                ))}

                {/* Area Fill */}
                <path d={areaPathD} fill="url(#ga4Gradient)" />

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
                  <strong style={{ color: "#a4ef51" }}>{points[hoveredPointIndex].rawVal.toLocaleString()}</strong>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SEO & Traffic Insights Section (Rule-Based, NO AI) */}
      <div className="console-section-card" style={{ marginTop: "24px" }}>
        <div className="card-header">
          <h4 className="card-title">Traffic &amp; Engagement Insights (Rule-Based)</h4>
          <p className="card-sub" style={{ marginTop: "4px" }}>Automated findings extracted deterministically from your Google Analytics 4 sessions.</p>
        </div>

        <div style={{ padding: "20px" }}>
          {report?.seoInsights && report.seoInsights.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
              {report.seoInsights.map((insight) => (
                <div key={insight.id} style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "16px" }}>
                  <div className="flex-between" style={{ marginBottom: "8px" }}>
                    <span style={{
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "4px",
                      textTransform: "uppercase",
                      background: insight.type === "poor_engagement" ? "#fef3c7" : insight.type === "high_bounce" ? "#fee2e2" : "#dcfce7",
                      color: insight.type === "poor_engagement" ? "#b45309" : insight.type === "high_bounce" ? "#b91c1c" : "#15803d",
                    }}>
                      {insight.type.replace("_", " ")}
                    </span>
                    <small className="text-muted" style={{ fontSize: "12px", fontWeight: 700 }}>{insight.metricLabel}</small>
                  </div>
                  <h5 style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: 700 }}>{insight.title}</h5>
                  <p className="card-sub" style={{ margin: 0, fontSize: "13px", lineHeight: "1.5" }}>{insight.description}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="card-sub">No engagement anomalies detected for the selected period.</p>
          )}
        </div>
      </div>

      {/* Two Column Layout: Traffic Sources & Landing Pages */}
      <div className="overview-two-col" style={{ marginTop: "24px" }}>

        {/* Traffic Sources Table */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Traffic Sources</h4></div>
          {isLoading ? (
            <p className="card-sub" style={{ padding: "20px" }}>Loading traffic channels...</p>
          ) : !report?.trafficSources || report.trafficSources.length === 0 ? (
            <p className="card-sub" style={{ padding: "20px" }}>No channel data returned by Google Analytics.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th style={{ textAlign: "right" }}>Users</th>
                    <th style={{ textAlign: "right" }}>Sessions</th>
                    <th style={{ textAlign: "right" }}>Engagement Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {report.trafficSources.map((s) => (
                    <tr key={s.channel}>
                      <td style={{ fontWeight: 600 }}>{s.channel}</td>
                      <td style={{ textAlign: "right" }}>{s.users}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{s.sessions}</td>
                      <td style={{ textAlign: "right" }}>{(s.engagementRate * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Top Landing Pages Table */}
        <div className="console-section-card">
          <div className="card-header flex-between">
            <h4 className="card-title">Top Landing Pages</h4>
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
            <p className="card-sub" style={{ padding: "20px" }}>Loading landing pages...</p>
          ) : filteredPages.length === 0 ? (
            <p className="card-sub" style={{ padding: "20px" }}>No pages found matching &quot;{pageSearch}&quot;.</p>
          ) : (
            <div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Page Path</th>
                      <th style={{ textAlign: "right" }}>Users</th>
                      <th style={{ textAlign: "right" }}>Sessions</th>
                      <th style={{ textAlign: "right" }}>Bounce</th>
                      <th style={{ textAlign: "right" }}>Eng. Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedPages.map((p) => (
                      <tr key={p.pagePath}>
                        <td style={{ fontWeight: 600 }} title={p.pagePath}>{p.pagePath}</td>
                        <td style={{ textAlign: "right" }}>{p.users}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{p.sessions}</td>
                        <td style={{ textAlign: "right" }}>{(p.bounceRate * 100).toFixed(1)}%</td>
                        <td style={{ textAlign: "right", color: "#6b7280" }}>{formatDuration(p.avgEngagementTimeSec)}</td>
                      </tr>
                    ))}
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
                  const maxUsers = Math.max(...report.countries.map((x) => x.users), 1);
                  const pct = Math.round((c.users / maxUsers) * 100);
                  return (
                    <div key={c.country}>
                      <div className="flex-between" style={{ fontSize: "13px", marginBottom: "4px" }}>
                        <span style={{ fontWeight: 600 }}>{c.country}</span>
                        <span style={{ fontWeight: 700 }}>{c.users} users</span>
                      </div>
                      <div style={{ height: "6px", background: "#f3f4f1", borderRadius: "3px", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: "#a4ef51", borderRadius: "3px" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="card-sub">No country data returned by Google Analytics.</p>
            )}
          </div>
        </div>

        {/* Devices & Tech */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Devices &amp; Technology</h4></div>
          <div style={{ padding: "20px" }}>
            {report?.devices && report.devices.categories.length > 0 ? (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginBottom: "16px" }}>
                  {report.devices.categories.map((dev) => (
                    <div key={dev.device} style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px", textAlign: "center" }}>
                      <small className="text-muted" style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase" }}>{dev.device}</small>
                      <div style={{ fontSize: "20px", fontWeight: 800, margin: "4px 0" }}>{dev.percentage}%</div>
                      <span className="text-muted" style={{ fontSize: "12px" }}>{dev.users} users</span>
                    </div>
                  ))}
                </div>

                {report.devices.browsers.length > 0 && (
                  <div style={{ fontSize: "13px", color: "#4b5563" }}>
                    Top browsers: {report.devices.browsers.map((b) => `${b.browser} (${b.users})`).join(" · ")}
                  </div>
                )}
              </div>
            ) : (
              <p className="card-sub">No device breakdown returned by Google Analytics.</p>
            )}
          </div>
        </div>

      </div>

      {/* Events & Audience Section */}
      <div className="overview-two-col" style={{ marginTop: "24px" }}>

        {/* Top Events Table */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Top GA4 Events</h4></div>
          {isLoading ? (
            <p className="card-sub" style={{ padding: "20px" }}>Loading GA4 events...</p>
          ) : !report?.events || report.events.length === 0 ? (
            <p className="card-sub" style={{ padding: "20px" }}>No event data returned by Google Analytics.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Event Name</th>
                    <th style={{ textAlign: "right" }}>Count</th>
                    <th style={{ textAlign: "right" }}>Users</th>
                  </tr>
                </thead>
                <tbody>
                  {report.events.map((e) => (
                    <tr key={e.eventName}>
                      <td style={{ fontWeight: 600 }}>{e.eventName}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{e.count.toLocaleString()}</td>
                      <td style={{ textAlign: "right", color: "#6b7280" }}>{e.users.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Audience Overview */}
        <div className="console-section-card">
          <div className="card-header"><h4 className="card-title">Audience Overview</h4></div>
          <div style={{ padding: "20px" }}>
            {report?.audience ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
                <div style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "14px" }}>
                  <span className="text-muted" style={{ fontSize: "12px", fontWeight: 700 }}>New Users</span>
                  <div style={{ fontSize: "22px", fontWeight: 800, margin: "4px 0" }}>{report.audience.newUsers.toLocaleString()}</div>
                </div>
                <div style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "14px" }}>
                  <span className="text-muted" style={{ fontSize: "12px", fontWeight: 700 }}>Returning Users</span>
                  <div style={{ fontSize: "22px", fontWeight: 800, margin: "4px 0" }}>{report.audience.returningUsers.toLocaleString()}</div>
                </div>
                <div style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "14px" }}>
                  <span className="text-muted" style={{ fontSize: "12px", fontWeight: 700 }}>Sessions Per User</span>
                  <div style={{ fontSize: "22px", fontWeight: 800, margin: "4px 0" }}>{report.audience.sessionsPerUser}</div>
                </div>
                <div style={{ background: "#f8f9f8", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "14px" }}>
                  <span className="text-muted" style={{ fontSize: "12px", fontWeight: 700 }}>Avg Session Duration</span>
                  <div style={{ fontSize: "22px", fontWeight: 800, margin: "4px 0" }}>{formatDuration(report.audience.avgSessionDurationSec)}</div>
                </div>
              </div>
            ) : (
              <p className="card-sub">No audience metrics available.</p>
            )}
          </div>
        </div>

      </div>

      {/* Conversions Section (Conditional) */}
      {report?.conversions && report.conversions.length > 0 && (
        <div className="console-section-card" style={{ marginTop: "24px" }}>
          <div className="card-header"><h4 className="card-title">Key Conversions</h4></div>
          <div style={{ padding: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
              {report.conversions.map((conv) => (
                <div key={conv.eventName} style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "14px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 800, color: "#166534", textTransform: "uppercase" }}>{conv.eventName}</span>
                  <div style={{ fontSize: "22px", fontWeight: 800, color: "#14532d", margin: "4px 0" }}>{conv.count}</div>
                  <small style={{ color: "#166534" }}>{(conv.rate * 100).toFixed(1)}% Conversion Rate</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
