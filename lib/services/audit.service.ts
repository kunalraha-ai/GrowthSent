import { ObjectId } from "mongodb";
import { connectToDatabase, safeObjectId } from "../db/mongodb.js";
import { validateUrlForScan } from "../security/ssrf.js";
import { runCrawl } from "../crawler/crawler.js";
import { analyzeCrawlResults } from "../seo/engine.js";
import {
  CrawlJobDocument,
  ScanDocument,
  PageDocument,
  IssueDocument,
  CrawlSnapshotDocument,
  SeoIssueHistoryDocument,
} from "../db/types.js";

export class AuditService {
  /**
   * Initiates an asynchronous crawl job and returns immediately with the jobId.
   */
  static async createCrawlJob(inputUrl: string, clerkUserId?: string, websiteId?: string): Promise<{ jobId: string; status: string }> {
    const ssrf = await validateUrlForScan(inputUrl);
    if (!ssrf.isValid || !ssrf.normalizedUrl) {
      throw new Error(ssrf.reason || "Invalid URL for scan.");
    }

    const { db } = await connectToDatabase();
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const jobDoc: CrawlJobDocument = {
      jobId,
      url: ssrf.normalizedUrl,
      clerkUserId,
      websiteId: websiteId ? safeObjectId(websiteId) : undefined,
      status: "queued",
      progressPercent: 0,
      pagesCrawled: 0,
      createdAt: new Date(),
    };

    await db.collection<CrawlJobDocument>("crawlJobs").insertOne(jobDoc);

    // Asynchronously trigger the crawler background execution without blocking HTTP response
    setTimeout(() => {
      AuditService.processCrawlJob(jobId).catch((err) => {
        console.error(`[AuditService] Async crawl job ${jobId} failed:`, err);
      });
    }, 10);

    return { jobId, status: "queued" };
  }

  /**
   * Polling endpoint handler for retrieving status and results of a crawl job.
   */
  static async getCrawlJobStatus(jobId: string, userId?: string) {
    const { db } = await connectToDatabase();
    const job = await db.collection<CrawlJobDocument>("crawlJobs").findOne({ jobId });
    if (!job) return null;

    if (job.clerkUserId && userId && job.clerkUserId !== userId) {
      return null;
    }

    if (job.status === "completed" && job.scanId) {
      const scan = await db.collection<ScanDocument>("scans").findOne({ _id: job.scanId });
      const pages = await db
        .collection<PageDocument>("pages")
        .find({ scanId: job.scanId })
        .limit(100)
        .toArray();
      const issues = await db
        .collection<IssueDocument>("issues")
        .find({ scanId: job.scanId })
        .toArray();

      return {
        jobId: job.jobId,
        status: job.status,
        progressPercent: 100,
        pagesCrawled: job.pagesCrawled,
        scan,
        pages,
        issues,
      };
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progressPercent: job.progressPercent,
      pagesCrawled: job.pagesCrawled,
      error: job.error,
    };
  }

  /**
   * Internal processor for running an asynchronous crawl job.
   */
  private static async processCrawlJob(jobId: string) {
    const { db } = await connectToDatabase();
    await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
      { jobId },
      { $set: { status: "crawling", progressPercent: 20 } }
    );

    const job = await db.collection<CrawlJobDocument>("crawlJobs").findOne({ jobId });
    if (!job) return;

    try {
      const crawlResult = await runCrawl(job.url, { maxPages: 100 });
      await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
        { jobId },
        { $set: { status: "analysing", progressPercent: 70, pagesCrawled: crawlResult.pages.length } }
      );

      const hostname = crawlResult.hostname;
      const startTime = job.createdAt;
      const completionTime = new Date();

      // Evaluate deterministic SEO rules against the full crawl (robots.txt, sitemap, and per-page checks)
      const analysisRes = analyzeCrawlResults(crawlResult);
      const generatedIssues = analysisRes.issues;
      const scoreResult = analysisRes.scoring;

      const scanDoc: ScanDocument = {
        websiteId: job.websiteId,
        clerkUserId: job.clerkUserId,
        url: job.url,
        hostname,
        startTime,
        completionTime,
        status: "completed",
        crawlStats: {
          totalPagesCrawled: crawlResult.totalPagesCrawled,
          totalDurationMs: crawlResult.durationMs,
          bytesDownloaded: crawlResult.bytesDownloaded,
          statusCodesCount: crawlResult.statusCodesCount,
        },
        summaryMetrics: {
          totalChecks: scoreResult.totalChecks,
          passedChecks: scoreResult.passedChecks,
          failedChecks: scoreResult.failedChecks,
          criticalIssues: generatedIssues.filter((i) => i.severity === "critical").length,
          highIssues: generatedIssues.filter((i) => i.severity === "high").length,
          mediumIssues: generatedIssues.filter((i) => i.severity === "medium").length,
          lowIssues: generatedIssues.filter((i) => i.severity === "low").length,
          infoIssues: generatedIssues.filter((i) => i.severity === "info").length,
        },
        seoScore: scoreResult.score,
        ruleVersion: scoreResult.scoreVersion,
        scoreVersion: scoreResult.scoreVersion,
        createdAt: completionTime,
      };

      const scanRes = await db.collection<ScanDocument>("scans").insertOne(scanDoc);
      const scanId = scanRes.insertedId;

      // Insert Pages (flatten crawler's nested parsedData into the PageDocument schema)
      const pagesToInsert: PageDocument[] = crawlResult.pages.map((p) => ({
        scanId,
        websiteId: job.websiteId,
        url: p.url,
        normalizedUrl: p.normalizedUrl,
        statusCode: p.statusCode,
        responseTimeMs: p.responseTimeMs,
        contentType: p.contentType,
        pageSizeBytes: p.pageSizeBytes,
        title: p.parsedData?.title,
        metaDescription: p.parsedData?.metaDescription,
        headings: p.parsedData?.headings || { h1: [], h2Count: 0, h3Count: 0 },
        canonicalUrl: p.parsedData?.canonicalUrl,
        isNoindex: p.parsedData?.isNoindex || false,
        isNofollow: p.parsedData?.isNofollow || false,
        hasRobotsTxtDisallow: p.hasRobotsTxtDisallow,
        structuredDataTypes: p.parsedData?.structuredDataTypes || [],
        internalLinks: p.parsedData?.internalLinks || [],
        externalLinks: p.parsedData?.externalLinks || [],
        hreflangs: p.parsedData?.hreflangs || {},
        createdAt: completionTime,
      }));
      if (pagesToInsert.length > 0) {
        await db.collection("pages").insertMany(pagesToInsert);
      }

      // Insert Issues
      const issuesToInsert = generatedIssues.map((i) => ({
        ...i,
        scanId,
        websiteId: job.websiteId,
        createdAt: completionTime,
      }));
      if (issuesToInsert.length > 0) {
        await db.collection("issues").insertMany(issuesToInsert);
      }

      // Record Point-in-Time Crawl Snapshot for trend tracking
      if (job.websiteId) {
        const snapshotDoc: CrawlSnapshotDocument = {
          websiteId: job.websiteId,
          scanId,
          clerkUserId: job.clerkUserId,
          seoScore: scoreResult.score,
          ruleVersion: scoreResult.scoreVersion,
          totalIssuesCount: generatedIssues.length,
          criticalCount: scanDoc.summaryMetrics.criticalIssues,
          highCount: scanDoc.summaryMetrics.highIssues,
          mediumCount: scanDoc.summaryMetrics.mediumIssues,
          lowCount: scanDoc.summaryMetrics.lowIssues,
          totalPagesCount: crawlResult.pages.length,
          snapshotDate: completionTime,
          createdAt: completionTime,
        };
        await db.collection<CrawlSnapshotDocument>("crawlSnapshots").insertOne(snapshotDoc);

        // Update Issue Lifecycle History (detected, resolved, reoccurred)
        for (const issue of generatedIssues) {
          await db.collection<SeoIssueHistoryDocument>("seoIssueHistory").updateOne(
            { websiteId: job.websiteId, ruleId: issue.ruleId, affectedUrl: issue.affectedUrl },
            {
              $set: {
                category: issue.category,
                severity: issue.severity,
                title: issue.title,
                status: "active",
                lastDetectedAt: completionTime,
                updatedAt: completionTime,
              },
              $setOnInsert: {
                firstDetectedAt: completionTime,
                createdAt: completionTime,
              },
              $push: {
                historyEvents: {
                  event: "detected",
                  timestamp: completionTime,
                  scanId,
                },
              },
            },
            { upsert: true }
          );
        }
      }

      // Mark Job Completed
      await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
        { jobId },
        {
          $set: {
            status: "completed",
            progressPercent: 100,
            pagesCrawled: crawlResult.pages.length,
            scanId,
            completedAt: completionTime,
          },
        }
      );
    } catch (err: any) {
      await db.collection<CrawlJobDocument>("crawlJobs").updateOne(
        { jobId },
        {
          $set: {
            status: "failed",
            error: err.message || "Crawling failed.",
          },
        }
      );
    }
  }
}
