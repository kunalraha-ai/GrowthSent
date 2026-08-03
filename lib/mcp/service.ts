import { createScan, getScanById, getScanIssues } from "../scans/service.js";

export interface McpScanRequest {
  url: string;
}

export interface McpIssueResponse {
  ruleId: string;
  category: string;
  severity: string;
  title: string;
  affectedUrl: string;
  recommendation: string;
  aiSuggestedFix?: string;
}

export class GrowthSentMcpService {
  async triggerScan(request: McpScanRequest) {
    const scan = await createScan({ url: request.url });
    return {
      scanId: scan._id?.toString(),
      status: scan.status,
      url: scan.url,
    };
  }

  async getStructuredIssues(scanId: string): Promise<McpIssueResponse[]> {
    const issues = await getScanIssues(scanId);
    return issues.map((i) => ({
      ruleId: i.ruleId,
      category: i.category,
      severity: i.severity,
      title: i.title,
      affectedUrl: i.affectedUrl,
      recommendation: i.recommendation,
      aiSuggestedFix: `Fix ${i.title}: ${i.recommendation}`,
    }));
  }
}
