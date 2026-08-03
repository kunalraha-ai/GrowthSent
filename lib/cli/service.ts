import { createScan, getScanById, getScanIssues } from "../scans/service.js";

export async function runCliScanCommand(url: string) {
  console.log(`[GrowthSent CLI] Starting scan for ${url}...`);
  const scan = await createScan({ url });
  console.log(`[GrowthSent CLI] Scan queued with ID: ${scan._id?.toString()}`);
  return scan;
}
