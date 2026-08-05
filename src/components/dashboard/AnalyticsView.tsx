import React, { useEffect, useState } from "react";

interface AnalyticsViewProps {
  activeSite?: string;
  websiteId: string | null;
}

interface Ga4Report {
  propertyId: string;
  propertyDisplayName?: string;
  totals: {
    activeUsers: number;
    sessions: number;
    screenPageViews: number;
    bounceRate: number;
    avgSessionDurationSec: number;
  };
  trend: Array<{ date: string; activeUsers: number; sessions: number; screenPageViews: number }>;
  topPages: Array<{ pagePath: string; screenPageViews: number }>;
  topChannels: Array<{ channel: string; sessions: number }>;
}

const emptyReport: Ga4Report = {
  propertyId: "",
  totals: { activeUsers: 0, sessions: 0, screenPageViews: 0, bounceRate: 0, avgSessionDurationSec: 0 },
  trend: [],
  topPages: [],
  topChannels: [],
};

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

export function AnalyticsView({ activeSite, websiteId }: AnalyticsViewProps) {
  const [days, setDays] = useState("30");
  const [report, setReport] = useState<Ga4Report>(emptyReport);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notConnected, setNotConnected] = useState(false);
  const [noPropertySelected, setNoPropertySelected] = useState(false);

  useEffect(() => {
    if (!websiteId) {
      setReport(emptyReport);
      return;
    }
    async function loadReport() {
      setIsLoading(true);
      setError("");
      setNotConnected(false);
      setNoPropertySelected(false);
      try {
        const response = await fetch(`/api/v1/ga4-report?websiteId=${websiteId}&days=${days}`);
        const data = await response.json();
        if (!response.ok) {
          const message: string = data.error?.message || "Unable to load Google Analytics data.";
          if (/not connected/i.test(message)) setNotConnected(true);
          else if (/no google analytics property/i.test(message)) setNoPropertySelected(true);
          else setError(message);
          setReport(emptyReport);
          return;
        }
        setReport({ ...emptyReport, ...data });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load Google Analytics data.");
        setReport(emptyReport);
      } finally {
        setIsLoading(false);
      }
    }
    loadReport();
  }, [websiteId, days]);

  return (
    <div className="analytics-view">
      <div className="console-title flex-between">
        <div><h3 className="title-text">Analytics{activeSite ? ` for ${activeSite}` : ""}</h3></div>
        <select value={days} onChange={(event) => setDays(event.target.value)} className="filter-select">
          <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
        </select>
      </div>
      {error && <p role="alert" style={{ color: "#b42318", marginTop: "16px" }}>{error}</p>}
      {!websiteId ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}><p className="card-sub">Add a website to view its Google Analytics data.</p></div>
      ) : notConnected ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}>
          <p className="card-sub">
            Google Analytics isn't connected for this website yet. Connect it from the sidebar to see real
            traffic data here.
          </p>
        </div>
      ) : noPropertySelected ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}>
          <p className="card-sub">
            Google Analytics is connected, but no GA4 property has been selected yet. Go to the Google
            Analytics tab to pick one.
          </p>
        </div>
      ) : (
        <>
          <div className="metrics-grid" style={{ marginTop: "20px" }}>
            <div className="metric-card"><p className="metric-label">Active Users</p><b className="metric-val">{isLoading ? "—" : report.totals.activeUsers.toLocaleString()}</b><span className="metric-sub text-muted">Last {days} days</span></div>
            <div className="metric-card"><p className="metric-label">Sessions</p><b className="metric-val">{isLoading ? "—" : report.totals.sessions.toLocaleString()}</b><span className="metric-sub text-muted">Last {days} days</span></div>
            <div className="metric-card"><p className="metric-label">Pageviews</p><b className="metric-val">{isLoading ? "—" : report.totals.screenPageViews.toLocaleString()}</b><span className="metric-sub text-muted">Last {days} days</span></div>
            <div className="metric-card"><p className="metric-label">Bounce Rate</p><b className="metric-val">{isLoading ? "—" : `${(report.totals.bounceRate * 100).toFixed(1)}%`}</b><span className="metric-sub text-muted">Avg session {isLoading ? "—" : formatDuration(report.totals.avgSessionDurationSec)}</span></div>
          </div>
          <div className="overview-two-col" style={{ marginTop: "24px" }}>
            <div className="console-section-card">
              <div className="card-header"><h4 className="card-title">Top Pages</h4></div>
              {isLoading ? <p className="card-sub" style={{ padding: "20px" }}>Loading analytics…</p> : report.topPages.length ? (
                <div className="compact-rows-list">
                  {report.topPages.map((page) => (
                    <div className="analytics-metric-row" key={page.pagePath}>
                      <span className="row-label">{page.pagePath}</span>
                      <p className="row-summary">{page.screenPageViews.toLocaleString()} views</p>
                    </div>
                  ))}
                </div>
              ) : <p className="card-sub" style={{ padding: "20px" }}>No page data for this period.</p>}
            </div>
            <div className="console-section-card">
              <div className="card-header"><h4 className="card-title">Top Channels</h4></div>
              {isLoading ? <p className="card-sub" style={{ padding: "20px" }}>Loading analytics…</p> : report.topChannels.length ? (
                <div className="compact-rows-list">
                  {report.topChannels.map((channel) => (
                    <div className="analytics-metric-row" key={channel.channel}>
                      <span className="row-label">{channel.channel}</span>
                      <p className="row-summary">{channel.sessions.toLocaleString()} sessions</p>
                    </div>
                  ))}
                </div>
              ) : <p className="card-sub" style={{ padding: "20px" }}>No channel data for this period.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
