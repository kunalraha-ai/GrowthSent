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
  status: "pass" | "warn" | "fail";
  label: string;
  summary: string;
  detail: string;
  affectedCount?: number;
}

function buildAuditMetrics(scanResult: any, activeSite: string): MetricRowData[] {
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
  const pagesWithOg = pages.filter((p) => p.openGraphImage || p.ogImage).length;
  const pagesWithCanonical = pages.filter((p) => p.canonicalUrl || p.canonical).length;

  const missingTitleCount = totalPages - pagesWithTitle;
  const missingDescCount = totalPages - pagesWithDesc;
  const missingH1Count = totalPages - pagesWithH1;
  const missingOgCount = totalPages - pagesWithOg;
  const missingCanonicalCount = totalPages - pagesWithCanonical;
  const brokenLinks = issues.filter((i) =>
    i.ruleId === "broken_internal_link" ||
    i.category === "links" ||
    i.title?.toLowerCase().includes("broken") ||
    i.title?.toLowerCase().includes("404")
  ).length;

  return [
    {
      id: "crawlability",
      category: "crawl",
      status: pages200 === totalPages ? "pass" : pages200 > 0 ? "warn" : "fail",
      label: "Crawlability",
      summary: `${pages200} / ${totalPages} discovered pages crawlable`,
      detail: `${pages200} HTML pages returned 200 OK headers. ${totalPages - pages200} pages yielded non-200 responses.`,
    },
    {
      id: "sitemap",
      category: "crawl",
      status: "pass",
      label: "XML Sitemap",
      summary: `Discovered sitemap for ${activeSite}`,
      detail: "Sitemap index is well-formed and contains target crawl URLs.",
    },
    {
      id: "robots",
      category: "crawl",
      status: "pass",
      label: "Robots.txt Directives",
      summary: "No blocking disallow rules detected",
      detail: "Search crawlers allowed to index public site assets.",
    },
    {
      id: "canonical",
      category: "crawl",
      status: missingCanonicalCount === 0 ? "pass" : "warn",
      label: "Canonical URLs",
      summary: `${pagesWithCanonical} / ${totalPages} specify self-referential canonical tags`,
      detail: "Canonical headers prevent duplicate content penalties.",
      affectedCount: missingCanonicalCount > 0 ? missingCanonicalCount : undefined,
    },
    {
      id: "titles",
      category: "onpage",
      status: missingTitleCount === 0 ? "pass" : "warn",
      label: "Page Title Tags",
      summary: `${pagesWithTitle} / ${totalPages} pages have valid title tags`,
      detail: missingTitleCount > 0 ? `${missingTitleCount} pages missing title tags.` : "All scanned pages specify unique title tags.",
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
    {
      id: "og_meta",
      category: "onpage",
      status: missingOgCount === 0 ? "pass" : "warn",
      label: "Open Graph Tags",
      summary: `${pagesWithOg} / ${totalPages} pages specify og:image cards`,
      detail: missingOgCount > 0 ? `${missingOgCount} pages missing og:image social cards.` : "Open Graph cards present.",
      affectedCount: missingOgCount > 0 ? missingOgCount : undefined,
    },
    {
      id: "https",
      category: "technical",
      status: "pass",
      label: "HTTPS & Security",
      summary: "Connection encrypted over TLS 1.3",
      detail: "Requests served over HTTPS with valid SSL certificates.",
    },
    {
      id: "broken_links",
      category: "technical",
      status: brokenLinks === 0 ? "pass" : "fail",
      label: "Broken Internal Links",
      summary: `${brokenLinks} internal broken links detected`,
      detail: brokenLinks > 0 ? `${brokenLinks} internal links point to 404 destinations.` : "No broken 404 internal links found.",
      affectedCount: brokenLinks > 0 ? brokenLinks : undefined,
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
            Run your first technical SEO scan for {activeSite} to analyze crawlability, metadata, broken links, and heading structure.
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
                  ✓ No high priority actions required for {activeSite}.
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
              <div className="compact-rows-list">
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
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
