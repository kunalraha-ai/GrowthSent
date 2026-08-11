import { createScan, getScanById, getScanIssues } from "../scans/service.js";

export async function runCliScanCommand(url: string) {
  // Do not echo a user-supplied URL before validation; it may contain
  // credentials even though createScan will correctly reject it.
  console.log("[GrowthSent CLI] Starting scan...");
  const scan = await createScan({ url });
  console.log(`[GrowthSent CLI] Scan queued with ID: ${scan._id?.toString()}`);
  return scan;
}
