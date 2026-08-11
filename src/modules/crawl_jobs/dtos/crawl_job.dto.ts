import {
  ICrawlJob,
  CrawlJobEngine,
  CrawlJobType,
  CrawlJobStatus,
  ICrawlJobConfiguration,
  ICrawlJobWorker,
  ICrawlJobStats,
  ICrawlJobError,
} from "../interfaces/crawl_job.interface";

export interface CrawlJobResponseDTO {
  publicId: string;
  domainPublicId: string;
  projectPublicId: string;
  triggeredByUserPublicId?: string;
  crawlSourcePublicId?: string;
  engine: CrawlJobEngine;
  jobType: CrawlJobType;
  status: CrawlJobStatus;
  configuration: ICrawlJobConfiguration;
  worker?: ICrawlJobWorker;
  stats: ICrawlJobStats;
  error?: ICrawlJobError;
  startedAt?: Date;
  completedAt?: Date;
  schemaVersion: string;
  createdAt: Date;
}

export function toCrawlJobResponseDTO(
  job: ICrawlJob,
  domainPublicId: string,
  projectPublicId: string,
  triggeredByUserPublicId?: string,
  crawlSourcePublicId?: string
): CrawlJobResponseDTO {
  return {
    publicId: job.publicId,
    domainPublicId,
    projectPublicId,
    triggeredByUserPublicId,
    crawlSourcePublicId,
    engine: job.engine,
    jobType: job.jobType,
    status: job.status,
    configuration: job.configuration,
    worker: job.worker,
    stats: job.stats,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    schemaVersion: job.schemaVersion,
    createdAt: job.createdAt,
  };
}
