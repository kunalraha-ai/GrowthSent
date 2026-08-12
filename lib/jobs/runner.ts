import { processNextQueuedScan, runScanJob } from "../scans/service.js";
import { applyAnalyticsRetentionPolicy } from "../analytics/retention.js";
import { AuditService } from "../services/audit.service.js";

export type JobType = "ScanJob" | "AuditCrawlJob" | "MonitoringJob" | "AnalyticsAggregationJob" | "NotificationJob";

export interface BackgroundJobPayload {
  jobId: string;
  type: JobType;
  payload: Record<string, any>;
}

export async function dispatchBackgroundJob(job: BackgroundJobPayload): Promise<boolean> {
  // Compatible with Vercel serverless execution or external workers
  switch (job.type) {
    case "ScanJob":
      if (job.payload.scanId) {
        await runScanJob(job.payload.scanId, job.payload.maxPages || 50);
      } else {
        await processNextQueuedScan();
      }
      break;
    case "AuditCrawlJob":
      if (job.payload.jobId) {
        await AuditService.processCrawlJob(job.payload.jobId);
      } else {
        await AuditService.processNextCrawlJob();
      }
      break;
    case "AnalyticsAggregationJob":
      await applyAnalyticsRetentionPolicy();
      break;
    default:
      console.log(`[JobRunner] Handled job ${job.type} (${job.jobId})`);
  }
  return true;
}

/**
 * Worker-facing polling hook for the external MVP. It intentionally performs
 * at most one canonical 25-page audit. Legacy scans remain readable for
 * historical data, but this public scheduler must never start their 50/150/200
 * page worker paths.
 */
export async function processDurableCrawlWork(): Promise<{
  auditClaimed: boolean;
  scanClaimed: boolean;
  auditStatus?: string;
  auditAttempt?: number;
  auditQueueAgeMs?: number;
}> {
  const audit = await AuditService.processNextCrawlJob();
  return {
    auditClaimed: audit.claimed,
    scanClaimed: false,
    auditStatus: audit.status,
    auditAttempt: audit.attempt,
    auditQueueAgeMs: audit.queueAgeMs,
  };
}
