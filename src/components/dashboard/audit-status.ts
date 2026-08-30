export type AuditJobUiStatus = "queued" | "crawling" | "analysing" | "completed" | "failed" | null;

export interface AuditProgress {
  status: AuditJobUiStatus;
  progressPercent: number;
  pagesCrawled: number;
}

export function toAuditJobUiStatus(value: unknown): AuditJobUiStatus {
  return value === "queued" || value === "crawling" || value === "analysing" || value === "completed" || value === "failed"
    ? value
    : null;
}

export function auditProgressLabel(isScanning: boolean, status: AuditJobUiStatus): string {
  if (!isScanning) return "Run Fresh Scan ↻";
  if (status === "queued") return "Starting audit...";
  if (status === "crawling") return "Crawling pages...";
  if (status === "analysing") return "Analyzing results...";
  return "Preparing audit...";
}

export function toAuditProgress(value: unknown): AuditProgress {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const progressPercent = typeof record.progressPercent === "number" && Number.isFinite(record.progressPercent)
    ? Math.max(0, Math.min(100, Math.round(record.progressPercent)))
    : 0;
  const pagesCrawled = typeof record.pagesCrawled === "number" && Number.isFinite(record.pagesCrawled)
    ? Math.max(0, Math.floor(record.pagesCrawled))
    : 0;
  return { status: toAuditJobUiStatus(record.status), progressPercent, pagesCrawled };
}

export function auditProgressDescription(progress: AuditProgress): { title: string; detail: string } {
  switch (progress.status) {
    case "queued":
      return {
        title: "Audit accepted",
        detail: "Preparing the bounded crawl. This page will update as soon as work begins.",
      };
    case "crawling":
      return {
        title: "Checking public pages",
        detail: progress.pagesCrawled > 0
          ? `${progress.pagesCrawled} public URL${progress.pagesCrawled === 1 ? "" : "s"} checked so far.`
          : "Connecting to the public homepage and collecting crawl evidence.",
      };
    case "analysing":
      return {
        title: "Analysing crawl evidence",
        detail: "Calculating technical SEO findings from the pages the crawl collected.",
      };
    default:
      return { title: "Preparing audit", detail: "Waiting for the latest audit status." };
  }
}
