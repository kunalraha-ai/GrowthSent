import React, { useState } from "react";
import { SeverityBadge } from "./SeverityIcon";
import { OverviewSkeleton } from "./SkeletonLoaders";
import { auditProgressLabel, type AuditJobUiStatus } from "./audit-status";

interface SeoAuditViewProps {
  activeSite: string;
  onNavigateTab: (tab: string) => void;
  onRunScan: () => void;
  isScanning: boolean;
  auditStatus?: AuditJobUiStatus;
  scanResult?: any;
}

interface MetricRowData {
  id: string;
  category: "crawl" | "onpage" | "technical";
  status: "pass" | "warn" | "fail" | "not_evaluated";
  label: string;
  summary: string;
  detail: string;
  affectedCount?: number;
}

export function buildAuditMetrics(scanResult: any, activeSite: string): MetricRowData[] {
  if (!scanResult) {
    return [];
  }

  const pages: any[] = scanResult.pages || [];
  const issues: any[] = scanResult.issues || [];
  const totalPages = scanResult.scan?.crawlStats?.totalPagesCrawled || pages.length || 0;

  if (totalPages === 0) {
    return [
      {
        id: "connection_error",
        category: "crawl",
        status: "fail",
        label: "Server Connection",
        summary: `0 / 0 pages crawlable for ${activeSite}`,
        detail: "Domain name could not be resolved or server connection timed out.",
        affectedCount: 1,
      },
    ];
  }

  const pages200 = pages.filter((p) => p.statusCode === 200).length;
  const pagesWithTitle = pages.filter((p) => p.title && p.title.trim().length > 0).length;
  const pagesWithDesc = pages.filter((p) => p.metaDescription && p.metaDescription.trim().length > 0).length;
  const pagesWithH1 = pages.filter((p) => {
    const h1Arr = p.h1 || p.headings?.h1;
    return h1Arr && Array.isArray(h1Arr) && h1Arr.length === 1;
  }).length;
  const pagesWithCanonical = pages.filter((p) => p.canonicalUrl || p.canonical).length;

  const missingTitleCount = totalPages - pagesWithTitle;
  const missingDescCount = totalPages - pagesWithDesc;
  const missingH1Count = totalPages - pagesWithH1;
  const missingCanonicalCount = totalPages - pagesWithCanonical;

  return [
    {
      id: "crawlability",
      category: "crawl",
      status: pages200 === totalPages ? "pass" : pages200 > 0 ? "warn" : "fail",
       label: "Successful Page Responses",
       summary: `${pages200} / ${totalPages} attempted URLs returned HTTP 200`,
       detail: `${pages200} attempted URLs returned HTTP 200. ${totalPages - pages200} yielded another status or could not be fetched.`,
    },
    {
      id: "canonical",
      category: "crawl",
      status: missingCanonicalCount === 0 ? "pass" : "warn",
      label: "Canonical URLs",
       summary: `${pagesWithCanonical} / ${totalPages} pages include a canonical URL`,
       detail: "This audit records canonical tags and flags missing, malformed, or external canonicals. It does not infer that a tag is self-referential from its presence.",
      affectedCount: missingCanonicalCount > 0 ? missingCanonicalCount : undefined,
    },
    {
      id: "titles",
      category: "onpage",
      status: missingTitleCount === 0 ? "pass" : "warn",
      label: "Page Title Tags",
      summary: `${pagesWithTitle} / ${totalPages} pages have valid title tags`,
       detail: missingTitleCount > 0 ? `${missingTitleCount} pages are missing title tags.` : "All scanned pages include a title tag. Duplicate-title findings, if any, are listed separately as issues.",
      affectedCount: missingTitleCount > 0 ? missingTitleCount : undefined,
    },
    {
      id: "meta_desc",
      category: "onpage",
      status: missingDescCount === 0 ? "pass" : "warn",
      label: "Meta Descriptions",
      summary: `${pagesWithDesc} / ${totalPages} pages have meta descriptions`,
      detail: missingDescCount > 0 ? `${missingDescCount} pages lack meta descriptions.` : "All scanned pages include meta descriptions.",
      affectedCount: missingDescCount > 0 ? missingDescCount : undefined,
    },
    {
      id: "headings",
      category: "onpage",
      status: missingH1Count === 0 ? "pass" : "warn",
      label: "Heading Structure (H1)",
      summary: missingH1Count === 0 ? `All ${totalPages} pages have valid H1 heading` : `${missingH1Count} pages missing or having multiple H1 tags`,
      detail: "Proper heading hierarchy requires exactly one primary H1 tag per page.",
      affectedCount: missingH1Count > 0 ? missingH1Count : undefined,
    },
  ];
}

export function SeoAuditView({
  activeSite,
  onNavigateTab,
  onRunScan,
  isScanning,
  auditStatus = null,
  scanResult,
}: SeoAuditViewProps) {
  const [selectedMetric, setSelectedMetric] = useState<MetricRowData | null>(null);

  const metricsList = buildAuditMetrics(scanResult, activeSite);
  const crawlMetrics = metricsList.filter((m) => m.category === "crawl");
  const onpageMetrics = metricsList.filter((m) => m.category === "onpage");
  const technicalMetrics = metricsList.filter((m) => m.category === "technical");

  const rawIssues: any[] = scanResult?.issues && scanResult.issues.length > 0
    ? scanResult.issues
    : [];

  return (
    <div className="seo-audit-view">
      {/* Header Bar */}
      <div className="console-title flex-between">
        <div>
          <h3 className="title-text">Technical SEO for {activeSite}</h3>
        </div>

        <button className="secondary-btn" onClick={onRunScan} disabled={isScanning}>
          {auditProgressLabel(isScanning, auditStatus)}
        </button>
      </div>

      {isScanning ? (
        <div style={{ marginTop: "20px" }}>
          <OverviewSkeleton />
        </div>
      ) : metricsList.length === 0 ? (
        <div className="console-section-card" style={{ marginTop: "24px", padding: "40px", textAlign: "center" }}>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>⌕</div>
          <h4 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px 0" }}>
            No Audit Results for {activeSite}
          </h4>
          <p style={{ color: "#8c8d86", fontSize: "14px", maxWidth: "480px", margin: "0 auto 20px auto" }}>
            Run your first bounded technical SEO audit for {activeSite} to analyze the page-response and metadata evidence it collects.
          </p>
          <button className="primary-btn" onClick={onRunScan}>
            Run Fresh Scan ↻
          </button>
        </div>
      ) : (
        <>
          {/* Score Explanation Disclaimer Banner */}
          <div className="disclaimer-banner" style={{ marginTop: "20px" }}>
            <span className="info-icon">ℹ</span>
            <p>
              GrowthSent's SEO Health Score is based on technical SEO, crawlability, indexability, metadata, links and structured data checks. It does not represent Google rankings or search performance.
            </p>
          </div>

          {/* Your Next Best Actions Section */}
          <div className="console-section-card" style={{ marginTop: "20px" }}>
            <div className="card-header flex-between">
              <div>
                <h4 className="card-title">Your Next Best Actions</h4>
                <p className="card-sub">Prioritised by severity and discoverability impact</p>
              </div>
            </div>

            <div className="actions-list">
              {rawIssues.length === 0 ? (
                <div style={{ padding: "16px 20px", color: "#a4ef51", fontSize: "14px", fontWeight: 600 }}>
                  No issues were returned by the checks collected in this audit. This is not a statement that every SEO check passed.
                </div>
              ) : (
                rawIssues.slice(0, 3).map((iss: any, idx: number) => (
                  <div key={idx} className="action-row">
                    <SeverityBadge level={iss.severity || "high"} />
                    <div className="action-text">
                      <strong>{iss.title}</strong>
                      <p>{iss.description || iss.explanation || "Review URL configuration and fix meta tags."}</p>
                    </div>
                    <button className="text-btn" onClick={() => onNavigateTab("issues")}>
                      Fix Issue →
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Grouped Audit Metrics */}
          <div className="grouped-metrics-container" style={{ marginTop: "24px" }}>
            {/* Group 1: Crawl & Indexability */}
            <div className="console-section-card">
              <div className="card-header">
                <h4 className="card-title">1. Crawl &amp; Indexability</h4>
              </div>
              <div className="compact-rows-list">
                {crawlMetrics.map((m) => (
                  <div
                    key={m.id}
                    className="compact-metric-row"
                    onClick={() => setSelectedMetric(selectedMetric?.id === m.id ? null : m)}
                  >
                    <span className={`status-icon ${m.status}`}>
                      {m.status === "pass" ? "✓" : m.status === "warn" ? "⚠" : "✕"}
                    </span>
                    <span className="row-label">{m.label}</span>
                    <p className="row-summary">{m.summary}</p>
                    <span className="expand-indicator">
                      {selectedMetric?.id === m.id ? "▲" : "▼"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Group 2: On-page SEO */}
            <div className="console-section-card" style={{ marginTop: "20px" }}>
              <div className="card-header">
                <h4 className="card-title">2. On-page SEO</h4>
              </div>
              <div className="compact-rows-list">
                {onpageMetrics.map((m) => (
                  <div
                    key={m.id}
                    className="compact-metric-row"
                    onClick={() => setSelectedMetric(selectedMetric?.id === m.id ? null : m)}
                  >
                    <span className={`status-icon ${m.status}`}>
                      {m.status === "pass" ? "✓" : m.status === "warn" ? "⚠" : "✕"}
                    </span>
                    <span className="row-label">{m.label}</span>
                    <p className="row-summary">{m.summary}</p>
                    <span className="expand-indicator">
                      {selectedMetric?.id === m.id ? "▲" : "▼"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Group 3: Technical Health */}
            <div className="console-section-card" style={{ marginTop: "20px" }}>
              <div className="card-header">
                <h4 className="card-title">3. Technical Health</h4>
              </div>
              {technicalMetrics.length === 0 ? (
                <p className="card-sub" style={{ padding: "0 20px 20px" }}>
                  Transport/TLS, Open Graph, and complete sitemap validation are not evaluated by this bounded audit.
                </p>
              ) : <div className="compact-rows-list">
                {technicalMetrics.map((m) => (
                  <div
                    key={m.id}
                    className="compact-metric-row"
                    onClick={() => setSelectedMetric(selectedMetric?.id === m.id ? null : m)}
                  >
                    <span className={`status-icon ${m.status}`}>
                      {m.status === "pass" ? "✓" : m.status === "warn" ? "⚠" : "✕"}
                    </span>
                    <span className="row-label">{m.label}</span>
                    <p className="row-summary">{m.summary}</p>
                    <span className="expand-indicator">
                      {selectedMetric?.id === m.id ? "▲" : "▼"}
                    </span>
                  </div>
                ))}
              </div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
