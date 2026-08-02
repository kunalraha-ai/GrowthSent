import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb";
import { PageDocument, IssueDocument, ScanDocument, ScanStatus } from "../db/types";
import { validateUrlForScan } from "../security/ssrf";
import { runCrawl } from "../crawler/crawler";
import { analyzeCrawlResults } from "../seo/engine";

export interface CreateScanOptions {
  url: string;
  websiteId?: string;
  anonymousSessionId?: string;
  maxPages?: number;
}

export async function createScan(options: CreateScanOptions): Promise<ScanDocument> {
  const ssrf = await validateUrlForScan(options.url);
  if (!ssrf.isValid || !ssrf.normalizedUrl || !ssrf.hostname) {
    throw new Error(ssrf.reason || "Invalid URL for scanning.");
  }

  const { db } = await connectToDatabase();

  const scanDoc: ScanDocument = {
    url: ssrf.normalizedUrl,
    hostname: ssrf.hostname,
    websiteId: options.websiteId ? new ObjectId(options.websiteId) : undefined,
    anonymousSessionId: options.anonymousSessionId,
    startTime: new Date(),
    status: "queued",
    crawlStats: {
      totalPagesCrawled: 0,
      totalDurationMs: 0,
      bytesDownloaded: 0,
      statusCodesCount: {},
    },
    summaryMetrics: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      criticalIssues: 0,
      highIssues: 0,
      mediumIssues: 0,
      lowIssues: 0,
      infoIssues: 0,
    },
    seoScore: 0,
    ruleVersion: "1.0.0",
    scoreVersion: "1.0.0",
    createdAt: new Date(),
  };

  const res = await db.collection("scans").insertOne(scanDoc);
  scanDoc._id = res.insertedId;

  // Trigger scan execution asynchronously
  runScanJob(scanDoc._id.toString(), options.maxPages || 50).catch((err) => {
    console.error("Scan job execution background error:", err);
  });

  return scanDoc;
}

export async function runScanJob(scanId: string, maxPages = 50) {
  const { db } = await connectToDatabase();
  const scanObjId = new ObjectId(scanId);

  const scan = await db.collection<ScanDocument>("scans").findOne({ _id: scanObjId });
  if (!scan) return;

  // Update status: crawling
  await db.collection("scans").updateOne(
    { _id: scanObjId },
    { $set: { status: "crawling", startTime: new Date() } }
  );

  try {
    // 1. Run crawler
    const crawlRes = await runCrawl(scan.url, { maxPages });

    // Update status: analysing
    await db.collection("scans").updateOne(
      { _id: scanObjId },
      { $set: { status: "analysing" } }
    );

    // 2. Run SEO Analysis Engine
    const analysisRes = analyzeCrawlResults(crawlRes);

    // 3. Save Pages
    const pageDocs: PageDocument[] = crawlRes.pages.map((p) => ({
      scanId: scanObjId,
      websiteId: scan.websiteId,
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
      createdAt: new Date(),
    }));

    if (pageDocs.length > 0) {
      await db.collection("pages").insertMany(pageDocs);
    }

    // 4. Save Issues
    const issueDocs: IssueDocument[] = analysisRes.issues.map((iss) => ({
      ...iss,
      scanId: scanObjId,
      websiteId: scan.websiteId,
      createdAt: new Date(),
    }));

    if (issueDocs.length > 0) {
      await db.collection("issues").insertMany(issueDocs);
    }

    // Issue count break-down
    let criticalIssues = 0;
    let highIssues = 0;
    let mediumIssues = 0;
    let lowIssues = 0;
    let infoIssues = 0;

    for (const iss of issueDocs) {
      if (iss.severity === "critical") criticalIssues++;
      else if (iss.severity === "high") highIssues++;
      else if (iss.severity === "medium") mediumIssues++;
      else if (iss.severity === "low") lowIssues++;
      else if (iss.severity === "info") infoIssues++;
    }

    // 5. Update completed Scan record
    await db.collection("scans").updateOne(
      { _id: scanObjId },
      {
        $set: {
          status: "completed",
          completionTime: new Date(),
          crawlStats: {
            totalPagesCrawled: crawlRes.totalPagesCrawled,
            totalDurationMs: crawlRes.durationMs,
            bytesDownloaded: crawlRes.bytesDownloaded,
            statusCodesCount: crawlRes.statusCodesCount,
          },
          summaryMetrics: {
            totalChecks: analysisRes.scoring.totalChecks,
            passedChecks: analysisRes.scoring.passedChecks,
            failedChecks: analysisRes.scoring.failedChecks,
            criticalIssues,
            highIssues,
            mediumIssues,
            lowIssues,
            infoIssues,
          },
          seoScore: analysisRes.scoring.score,
          scoreVersion: analysisRes.scoring.scoreVersion,
        },
      }
    );

    // If linked to website, update website's lastScanAt timestamp
    if (scan.websiteId) {
      await db.collection("websites").updateOne(
        { _id: scan.websiteId },
        { $set: { lastScanAt: new Date() } }
      );
    }
  } catch (err: any) {
    await db.collection("scans").updateOne(
      { _id: scanObjId },
      {
        $set: {
          status: "failed",
          error: err.message || "An unexpected error occurred during scan execution.",
          completionTime: new Date(),
        },
      }
    );
  }
}

export async function getScanById(scanId: string): Promise<ScanDocument | null> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<ScanDocument>("scans").findOne({ _id: new ObjectId(scanId) });
  } catch {
    return null;
  }
}

export async function getScanPages(scanId: string): Promise<PageDocument[]> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<PageDocument>("pages").find({ scanId: new ObjectId(scanId) }).toArray();
  } catch {
    return [];
  }
}

export async function getScanIssues(scanId: string): Promise<IssueDocument[]> {
  const { db } = await connectToDatabase();
  try {
    return await db.collection<IssueDocument>("issues").find({ scanId: new ObjectId(scanId) }).toArray();
  } catch {
    return [];
  }
}
