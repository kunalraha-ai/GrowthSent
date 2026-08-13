import React, { useState } from "react";
import { SeverityBadge } from "./SeverityIcon";
import { OverviewSkeleton } from "./SkeletonLoaders";
import { auditProgressLabel, type AuditJobUiStatus } from "./audit-status";
import { isAuditResultEvaluable } from "./audit-evidence";

interface OverviewViewProps {
  activeSite: string;
  websites: { hostname: string }[];
  onSelectSite: (site: string) => void;
  onNavigateTab: (tab: string) => void;
  onRunScan: () => void;
  onScanUrl?: (url: string) => void;
  isScanning: boolean;
  auditStatus?: AuditJobUiStatus;
  isGscConnected: boolean;
  scanResult?: { scan?: any; issues?: any[] } | null;
}

export function OverviewView({
  activeSite,
  websites,
  onSelectSite,
  onNavigateTab,
  onRunScan,
  onScanUrl,
  isScanning,
  auditStatus = null,
  isGscConnected,
  scanResult,
}: OverviewViewProps) {
  const [inputUrl, setInputUrl] = useState("");
  const scan = scanResult?.scan;
  const issues = scanResult?.issues || [];
  const summary = scan?.summaryMetrics;
  const auditIsEvaluable = isAuditResultEvaluable(scanResult);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const target = inputUrl.trim() || (activeSite ? `https://${activeSite}` : "");
    if (target && onScanUrl) onScanUrl(target);
  };

  return (
    <div className="overview-view">
      <div className="console-title flex-between">
        <div>
          <h3 className="title-text">Website Overview</h3>
          {websites.length > 0 && <select value={activeSite} onChange={(event) => onSelectSite(event.target.value)} className="site-selector-dropdown"><option value="" disabled>Select a website</option>{websites.map((site) => <option key={site.hostname} value={site.hostname}>{site.hostname}</option>)}</select>}
        </div>
        <button className="secondary-btn" onClick={onRunScan} disabled={isScanning || !activeSite}>{auditProgressLabel(isScanning, auditStatus)}</button>
      </div>

      <form onSubmit={submit} style={{ marginTop: "16px", display: "flex", gap: "10px" }}>
        <input className="form-input" style={{ flex: 1 }} value={inputUrl} onChange={(event) => setInputUrl(event.target.value)} placeholder="https://yourwebsite.com" />
        <button className="primary-btn" type="submit" disabled={isScanning}>Add and scan</button>
      </form>

      {isScanning ? <div style={{ marginTop: "20px" }}><OverviewSkeleton /></div> : !scan ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}><h4 className="card-title">No audit data yet</h4><p className="card-sub">Add a public website and run a scan to see its live technical SEO data.</p></div>
      ) : (
        <>
          <div className="metrics-grid" style={{ marginTop: "20px" }}>
            <div className="metric-card"><p className="metric-label">SEO Health Score</p><b className="metric-val">{auditIsEvaluable ? `${scan.seoScore ?? 0}%` : "—"}</b><span className="metric-sub text-muted">{auditIsEvaluable ? `${scan.crawlStats?.totalPagesCrawled ?? 0} pages analyzed` : "Could not evaluate the root page"}</span></div>
            <div className="metric-card"><p className="metric-label">Active Issues</p><b className="metric-val warn-text">{issues.length}</b><span className="metric-sub text-muted">From the latest audit</span></div>
            <div className="metric-card"><p className="metric-label">Critical Issues</p><b className="metric-val">{summary?.criticalIssues ?? 0}</b><span className="metric-sub text-muted">Needs immediate attention</span></div>
            <div className="metric-card"><p className="metric-label">Search Console</p><b className="metric-val">{isGscConnected ? "Connected" : "—"}</b><span className="metric-sub text-muted">{isGscConnected ? "Live data available" : "Not connected"}</span></div>
          </div>
          <div className="overview-two-col" style={{ marginTop: "24px" }}>
            {auditIsEvaluable ? (
              <div className="console-section-card"><div className="card-header flex-between"><h4 className="card-title">Needs Your Attention</h4><button className="text-btn" onClick={() => onNavigateTab("issues")}>View all issues →</button></div>{issues.length ? <div className="attention-list">{issues.slice(0, 5).map((issue) => <div key={issue._id?.toString?.() || `${issue.ruleId}-${issue.affectedUrl}`} className={`attention-item ${issue.severity}`}><div className="item-badge-wrap"><SeverityBadge level={issue.severity || "medium"} /></div><div className="item-content"><strong>{issue.title}</strong><p>{issue.affectedUrl}</p></div></div>)}</div> : <p className="card-sub" style={{ padding: "20px" }}>No issues were returned by this audit.</p>}</div>
            ) : (
              <div className="console-section-card"><div className="card-header"><h4 className="card-title">Crawl Could Not Be Evaluated</h4></div><p className="card-sub" style={{ padding: "20px" }}>The root page was not retrieved as a successful HTML response. No SEO score or pass result is available.</p></div>
            )}
            <div className="console-section-card" style={{ display: "flex", flexDirection: "column" }}>
              <div className="card-header"><h4 className="card-title">Search Intelligence</h4></div>
              <div style={{ padding: "36px 24px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", flex: 1, minHeight: "220px" }}>
                <p className="card-sub" style={{ maxWidth: "440px", marginBottom: "24px", fontSize: "14px", lineHeight: "1.6" }}>
                  {isGscConnected
                    ? "Your connected Search Console data is available in Search Intelligence."
                    : "Connect Google Search Console to retrieve real clicks, impressions, queries, and ranking positions."}
                </p>
                <button
                  className="primary-btn"
                  onClick={() => onNavigateTab("gsc")}
                  style={{ padding: "12px 24px", fontSize: "14px", fontWeight: 700 }}
                >
                  {isGscConnected ? "View Search Intelligence →" : "Connect Google Search Console →"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
