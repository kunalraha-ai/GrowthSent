import { runScanJob } from "../scans/service";
import { applyAnalyticsRetentionPolicy } from "../analytics/retention";

export type JobType = "ScanJob" | "MonitoringJob" | "AnalyticsAggregationJob" | "NotificationJob";

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
