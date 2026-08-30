import type { IssueDocument, PageDocument, ScanDocument } from "../db/types.js";

/**
 * The deliberately narrow shape exposed by an audit share link. It contains
 * only findings derived from a public website; account, database, worker, and
 * capability fields are intentionally absent.
 */
export interface PublicAuditReport {
  scan: {
    hostname: string;
    url: string;
    status: "completed";
    completionTime?: Date;
    createdAt: Date;
    crawlStats: Pick<ScanDocument["crawlStats"], "totalPagesCrawled" | "totalDurationMs" | "bytesDownloaded" | "statusCodesCount" | "provider">;
    summaryMetrics: ScanDocument["summaryMetrics"];
    seoScore: number;
    scoreVersion: string;
  };
  pages: Array<Pick<PageDocument,
    "url" | "normalizedUrl" | "statusCode" | "responseTimeMs" | "contentType" | "pageSizeBytes" |
    "fetchFailureCategory" | "title" | "metaDescription" | "headings" | "canonicalUrl" | "isNoindex" |
    "isNofollow" | "hasRobotsTxtDisallow" | "structuredDataTypes" | "hreflangs"
  >>;
  issues: Array<Pick<IssueDocument,
    "ruleId" | "category" | "severity" | "title" | "description" | "explanation" |
    "affectedUrl" | "evidence" | "recommendation"
  >>;
}

export function buildPublicAuditReport(
  scan: ScanDocument,
  pages: PageDocument[],
  issues: IssueDocument[]
): PublicAuditReport {
  if (scan.status !== "completed") {
    throw new Error("Only completed audits can be shared.");
  }
  return {
    scan: {
      hostname: scan.hostname,
      url: scan.url,
      status: "completed",
      completionTime: scan.completionTime,
      createdAt: scan.createdAt,
      crawlStats: {
        totalPagesCrawled: scan.crawlStats.totalPagesCrawled,
        totalDurationMs: scan.crawlStats.totalDurationMs,
        bytesDownloaded: scan.crawlStats.bytesDownloaded,
        statusCodesCount: { ...scan.crawlStats.statusCodesCount },
        provider: scan.crawlStats.provider,
      },
      summaryMetrics: { ...scan.summaryMetrics },
      seoScore: scan.seoScore,
      scoreVersion: scan.scoreVersion,
    },
    pages: pages.map((page) => ({
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      statusCode: page.statusCode,
      responseTimeMs: page.responseTimeMs,
      contentType: page.contentType,
      pageSizeBytes: page.pageSizeBytes,
      fetchFailureCategory: page.fetchFailureCategory,
      title: page.title,
      metaDescription: page.metaDescription,
      headings: page.headings,
      canonicalUrl: page.canonicalUrl,
      isNoindex: page.isNoindex,
      isNofollow: page.isNofollow,
      hasRobotsTxtDisallow: page.hasRobotsTxtDisallow,
      structuredDataTypes: page.structuredDataTypes,
      hreflangs: page.hreflangs,
    })),
    issues: issues.map((issue) => ({
      ruleId: issue.ruleId,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      explanation: issue.explanation,
      affectedUrl: issue.affectedUrl,
      evidence: issue.evidence,
      recommendation: issue.recommendation,
    })),
  };
}
