import { IssueDocument, Severity } from "../db/types.js";

export interface ScoreCalculationResult {
  score: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  scoreVersion: string;
  deductionsBySeverity: Record<Severity, number>;
}

export const CURRENT_SCORE_VERSION = "1.0.0";

const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 15,
  high: 10,
  medium: 5,
  low: 2,
  info: 0,
};

export function calculateSeoScore(
  issues: Omit<IssueDocument, "_id" | "scanId" | "createdAt">[],
  totalPagesCrawled: number
): ScoreCalculationResult {
  const safePageCount = Math.max(1, totalPagesCrawled);
  const totalChecks = safePageCount * 10; // 10 core checks per page/site

  const deductionsBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  let totalDeductionPoints = 0;

  for (const issue of issues) {
    const weight = SEVERITY_WEIGHTS[issue.severity] || 0;
    deductionsBySeverity[issue.severity] += weight;
    totalDeductionPoints += weight;
  }

  // Normalized deduction per page count to prevent score penalization scaling purely on site size
  const normalizedDeduction = totalDeductionPoints / Math.sqrt(safePageCount);
  const rawScore = Math.max(0, Math.min(100, Math.round(100 - normalizedDeduction)));

  const failedChecks = issues.length;
  const passedChecks = Math.max(0, totalChecks - failedChecks);

  return {
    score: rawScore,
    totalChecks,
    passedChecks,
    failedChecks,
    scoreVersion: CURRENT_SCORE_VERSION,
    deductionsBySeverity,
  };
}
