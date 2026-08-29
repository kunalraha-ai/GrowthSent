export type AuditJobUiStatus = "queued" | "crawling" | "analysing" | "completed" | "failed" | null;

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
