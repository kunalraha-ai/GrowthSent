import React from "react";
import { SeverityBadge } from "./SeverityIcon";

interface AlertsViewProps {
  activeSite?: string;
  scanResult?: { scan?: any; issues?: any[] } | null;
}

export function AlertsView({ activeSite, scanResult }: AlertsViewProps) {
  const scan = scanResult?.scan;
  const issues = scanResult?.issues || [];
  const criticalIssues = issues.filter((issue) => issue.severity === "critical");
  const scannedAt = scan?.completionTime ? new Date(scan.completionTime).toLocaleString() : null;

  return (
    <div className="alerts-view">
      <div className="console-title"><h3 className="title-text">Alerts &amp; Monitoring{activeSite ? ` for ${activeSite}` : ""}</h3></div>
      {!scan ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}>
          <h4 className="card-title">No monitoring data yet</h4>
          <p className="card-sub">Run a scan to create the first set of SEO alerts for this website.</p>
        </div>
      ) : (
        <>
          <div className="metrics-grid" style={{ marginTop: "20px" }}>
            <div className="metric-card"><p className="metric-label">Last Scan</p><b className="metric-val">{scannedAt || "—"}</b><span className="metric-sub text-muted">Most recent completed audit</span></div>
            <div className="metric-card"><p className="metric-label">Pages Crawled</p><b className="metric-val">{scan.crawlStats?.totalPagesCrawled ?? 0}</b><span className="metric-sub text-muted">Latest audit</span></div>
            <div className="metric-card"><p className="metric-label">Critical Alerts</p><b className={`metric-val ${criticalIssues.length ? "warn-text" : "pass-text"}`}>{criticalIssues.length}</b><span className="metric-sub text-muted">From latest audit</span></div>
          </div>
          <div className="console-section-card" style={{ marginTop: "24px" }}>
            <div className="card-header"><h4 className="card-title">Latest audit alerts</h4></div>
            {issues.length ? <div className="actions-list">{issues.map((issue) => <div className="action-row" key={issue._id?.toString?.() || `${issue.ruleId}-${issue.affectedUrl}`}><SeverityBadge level={issue.severity || "medium"} /><div className="action-text"><strong>{issue.title}</strong><p>{issue.affectedUrl}</p></div></div>)}</div> : <p className="card-sub" style={{ padding: "20px" }}>The latest audit did not return any issues.</p>}
          </div>
        </>
      )}
    </div>
  );
}
