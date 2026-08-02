import React, { useState } from "react";
import { TableSkeleton } from "./SkeletonLoaders";

export interface DetailedIssue {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "warning";
  ruleName: string;
  url: string;
  explanation: string;
  whyItMatters: string;
  howToFix: string;
}

interface IssuesViewProps {
  activeSite?: string;
  onNavigateTab: (tab: string) => void;
  isScanning?: boolean;
  scanResult?: any;
}

export function IssuesView({
  activeSite = "example.com",
  onNavigateTab,
  isScanning = false,
  scanResult,
}: IssuesViewProps) {
  const [filterSeverity, setFilterSeverity] = useState<string>("all");

  const rawIssuesList: DetailedIssue[] = scanResult?.issues && scanResult.issues.length > 0
    ? scanResult.issues.map((i: any, idx: number) => ({
        id: i._id?.toString() || i.id || `iss-${idx}`,
        severity: i.severity || "medium",
        ruleName: i.ruleId || i.category || "seo_check",
        url: i.affectedUrl || i.url || "/",
        explanation: i.title || i.explanation || "SEO Issue Detected",
        whyItMatters: i.description || i.explanation || "Impacts search engine crawlability and ranking performance.",
        howToFix: i.recommendation || "Review the URL configuration and update HTML metadata tags.",
      }))
    : [];

  const criticalCount = rawIssuesList.filter((i) => i.severity === "critical").length;
  const highCount = rawIssuesList.filter((i) => i.severity === "high").length;
  const mediumCount = rawIssuesList.filter((i) => i.severity === "medium" || i.severity === "warning").length;
  const lowCount = rawIssuesList.filter((i) => i.severity === "low").length;

  const filteredIssues = rawIssuesList.filter(
    (i) =>
      filterSeverity === "all" ||
      i.severity === filterSeverity ||
      (filterSeverity === "medium" && i.severity === "warning")
  );

  return (
    <div className="issues-view">
      {/* Header Bar — matches Overview/Audit page header pattern */}
      <div className="console-title flex-between">
        <div>
          <p className="kicker">SEO ISSUES</p>
          <h3 className="title-text">Detected Issues for {activeSite}</h3>
        </div>
      </div>

      {isScanning ? (
        <div style={{ marginTop: "20px" }}>
          <TableSkeleton />
        </div>
      ) : rawIssuesList.length === 0 ? (
        <div className="console-section-card" style={{ marginTop: "20px" }}>
          <div className="gsc-empty-state" style={{ padding: "48px 20px" }}>
            <div className="empty-icon-circle">✓</div>
            <h5>No Issues Detected for {activeSite}</h5>
            <p>All scanned pages passed technical SEO checks without critical errors.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Summary metric cards — same component/style as Overview & Audit pages */}
          <div className="metrics-grid" style={{ marginTop: "20px" }}>
            <div className="metric-card">
              <p className="metric-label">Critical</p>
              <b className="metric-val critical-text">{criticalCount}</b>
            </div>
            <div className="metric-card">
              <p className="metric-label">High</p>
              <b className="metric-val warn-text">{highCount}</b>
            </div>
            <div className="metric-card">
              <p className="metric-label">Warn</p>
              <b className="metric-val warn-text">{mediumCount}</b>
            </div>
            <div className="metric-card">
              <p className="metric-label">Low</p>
              <b className="metric-val pass-text">{lowCount}</b>
            </div>
          </div>

          {/* Issues list — wrapped in the same console-section-card used across the audit page */}
          <div className="console-section-card" style={{ marginTop: "20px" }}>
            <div className="card-header flex-between">
              <div>
                <h4 className="card-title">All Detected Issues</h4>
                <p className="card-sub">
                  {filteredIssues.length} of {rawIssuesList.length} issues shown
                </p>
              </div>
              <div className="severity-filter-bar">
                <div className="filter-buttons">
                  {["all", "critical", "high", "medium", "low"].map((sev) => (
                    <button
                      key={sev}
                      className={`filter-btn ${filterSeverity === sev ? "active" : ""}`}
                      onClick={() => setFilterSeverity(sev)}
                    >
                      {sev === "all" ? "All" : sev.charAt(0).toUpperCase() + sev.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ padding: "20px" }}>
              <div className="issues-cards-list">
                {filteredIssues.map((iss) => (
                  <div
                    key={iss.id}
                    className={`issue-card-item ${iss.severity === "warning" ? "medium" : iss.severity}`}
                  >
                    <div className="flex-between" style={{ marginBottom: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span className={`severity-badge ${iss.severity}`}>{iss.severity}</span>
                        <code className="rule-code">{iss.ruleName}</code>
                      </div>
                      <a href={iss.url} target="_blank" rel="noopener noreferrer" className="url-link-text">
                        {iss.url} ↗
                      </a>
                    </div>

                    <h4 className="issue-headline">{iss.explanation}</h4>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div className="why-how-box">
                        <strong>Why it matters</strong>
                        <p style={{ marginTop: "6px" }}>{iss.whyItMatters}</p>
                      </div>
                      <div className="why-how-box">
                        <strong>How to fix</strong>
                        <p style={{ marginTop: "6px" }}>{iss.howToFix}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
