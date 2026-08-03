import { ObjectId } from "mongodb";
import { connectToDatabase } from "../db/mongodb.js";
import { IssueDocument, PageDocument, MonitoringSnapshotDocument } from "../db/types.js";

export interface ScanComparisonResult {
  newIssuesCount: number;
  resolvedIssuesCount: number;
  newPagesCount: number;
  removedPagesCount: number;
  summary: {
    newIssues: string[];
    resolvedIssues: string[];
    newPages: string[];
    removedPages: string[];
  };
}

export async function compareScansAndSnapshot(
  websiteId: string,
  currentScanId: string,
  previousScanId?: string
): Promise<MonitoringSnapshotDocument | null> {
  const { db } = await connectToDatabase();
  const webObjId = new ObjectId(websiteId);
  const currScanObjId = new ObjectId(currentScanId);

  let prevScanObjId: ObjectId | null = null;
  if (previousScanId) {
    prevScanObjId = new ObjectId(previousScanId);
  } else {
    // Find previous scan automatically
    const prevScan = await db
      .collection("scans")
      .find({ websiteId: webObjId, _id: { $ne: currScanObjId }, status: "completed" })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();

    if (prevScan.length > 0) {
      prevScanObjId = prevScan[0]._id;
    }
  }

  const currentIssues = await db
    .collection<IssueDocument>("issues")
    .find({ scanId: currScanObjId })
    .toArray();
  const currentPages = await db
    .collection<PageDocument>("pages")
    .find({ scanId: currScanObjId })
    .toArray();

  let previousIssues: IssueDocument[] = [];
  let previousPages: PageDocument[] = [];

  if (prevScanObjId) {
    previousIssues = await db
      .collection<IssueDocument>("issues")
      .find({ scanId: prevScanObjId })
      .toArray();
    previousPages = await db
      .collection<PageDocument>("pages")
      .find({ scanId: prevScanObjId })
      .toArray();
  }

  const currentIssueKeys = new Set(currentIssues.map((i) => `${i.ruleId}:${i.affectedUrl}`));
  const previousIssueKeys = new Set(previousIssues.map((i) => `${i.ruleId}:${i.affectedUrl}`));

  const currentPageUrls = new Set(currentPages.map((p) => p.url));
  const previousPageUrls = new Set(previousPages.map((p) => p.url));

  const newIssues: string[] = [];
  for (const key of currentIssueKeys) {
    if (!previousIssueKeys.has(key)) newIssues.push(key);
  }

  const resolvedIssues: string[] = [];
  for (const key of previousIssueKeys) {
    if (!currentIssueKeys.has(key)) resolvedIssues.push(key);
  }

  const newPages: string[] = [];
  for (const url of currentPageUrls) {
    if (!previousPageUrls.has(url)) newPages.push(url);
  }

  const removedPages: string[] = [];
  for (const url of previousPageUrls) {
    if (!currentPageUrls.has(url)) removedPages.push(url);
  }

  const snapshotDoc: MonitoringSnapshotDocument = {
    websiteId: webObjId,
    scanId: currScanObjId,
    newIssuesCount: newIssues.length,
    resolvedIssuesCount: resolvedIssues.length,
    newPagesCount: newPages.length,
    removedPagesCount: removedPages.length,
    summary: {
      newIssues: newIssues.slice(0, 50),
      resolvedIssues: resolvedIssues.slice(0, 50),
      newPages: newPages.slice(0, 50),
      removedPages: removedPages.slice(0, 50),
    },
    createdAt: new Date(),
  };

  await db.collection("monitoringSnapshots").insertOne(snapshotDoc);
  return snapshotDoc;
}
