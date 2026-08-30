import type { jsPDF } from "jspdf";
import { isAuditResultEvaluable } from "./audit-evidence";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function text(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function dateLabel(value: unknown): string {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function reportFilename(hostname: unknown): string {
  const safeHost = text(hostname).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "website";
  return `growthsent-audit-${safeHost}.pdf`;
}

/** Builds a self-contained PDF locally in the visitor's browser. */
export async function createAuditReportPdf(scanResult: any): Promise<jsPDF> {
  const scan = scanResult?.scan;
  if (!scan) throw new Error("A completed audit is required to create a report.");

  const pages: any[] = Array.isArray(scanResult?.pages) ? scanResult.pages : [];
  const issues: any[] = Array.isArray(scanResult?.issues) ? scanResult.issues : [];
  const evaluable = isAuditResultEvaluable(scanResult);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true });
  const hostname = text(scan.hostname) || "Website audit";
  let y = MARGIN;

  const nextPage = () => {
    doc.addPage();
    y = MARGIN;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(85, 118, 51);
    doc.text(`GrowthSent audit - ${hostname}`, MARGIN, y);
    y += 24;
  };

  const ensureSpace = (height: number) => {
    if (y + height > PAGE_HEIGHT - MARGIN - 22) nextPage();
  };

  const wrappedHeight = (value: unknown, width: number, options: { size?: number; lineHeight?: number; bold?: boolean } = {}) => {
    doc.setFont("helvetica", options.bold ? "bold" : "normal");
    doc.setFontSize(options.size ?? 10);
    const lines = doc.splitTextToSize(text(value) || "Not recorded", width) as string[];
    return lines.length * (options.lineHeight ?? 14) + 3;
  };

  const writeWrapped = (value: unknown, width: number, options: { size?: number; lineHeight?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? 14;
    const content = text(value) || "Not recorded";
    doc.setFont("helvetica", options.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(options.color ?? [24, 33, 23]));
    const lines = doc.splitTextToSize(content, width) as string[];
    ensureSpace(lines.length * lineHeight + 3);
    doc.text(lines, MARGIN, y);
    y += lines.length * lineHeight + 3;
  };

  const heading = (value: string) => {
    ensureSpace(28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(24, 33, 23);
    doc.text(value, MARGIN, y);
    y += 26;
  };

  const label = (value: string) => {
    ensureSpace(16);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(85, 118, 51);
    doc.text(value.toUpperCase(), MARGIN, y);
    y += 14;
  };

  doc.setProperties({ title: `GrowthSent audit - ${hostname}`, subject: "Technical SEO audit" });
  label("GrowthSent technical SEO audit");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  doc.setTextColor(24, 33, 23);
  doc.text(hostname, MARGIN, y);
  y += 26;
  writeWrapped(
    `Completed ${dateLabel(scan.completionTime || scan.createdAt)}. This report contains only evidence collected by this bounded audit.`,
    CONTENT_WIDTH,
    { size: 10, lineHeight: 14, color: [89, 99, 86] }
  );
  y += 14;

  const score = evaluable && typeof scan.seoScore === "number" ? `${scan.seoScore}%` : "Not evaluated";
  const metrics = [
    { label: "SEO health score", value: score },
    { label: "Pages checked", value: text(scan.crawlStats?.totalPagesCrawled ?? pages.length) || "0" },
    { label: "Findings", value: text(issues.length) },
  ];
  const cardGap = 10;
  const cardWidth = (CONTENT_WIDTH - cardGap * 2) / 3;
  const cardHeight = 72;
  ensureSpace(cardHeight + 18);
  metrics.forEach((metric, index) => {
    const x = MARGIN + index * (cardWidth + cardGap);
    doc.setDrawColor(220, 228, 217);
    doc.setFillColor(251, 253, 249);
    doc.roundedRect(x, y, cardWidth, cardHeight, 8, 8, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(85, 118, 51);
    doc.text(metric.label.toUpperCase(), x + 10, y + 18);
    doc.setFontSize(18);
    doc.setTextColor(24, 33, 23);
    doc.text(metric.value, x + 10, y + 47);
  });
  y += cardHeight + 24;

  heading("Findings");
  if (issues.length === 0) {
    writeWrapped("No issues were returned by the checks collected in this audit.", CONTENT_WIDTH, { color: [89, 99, 86] });
  } else {
    issues.forEach((issue, index) => {
      if (index > 0) y += 7;
      const issueHeight = 14
        + wrappedHeight(issue.title || issue.ruleId || "Audit finding", CONTENT_WIDTH, { size: 12, lineHeight: 16, bold: true })
        + wrappedHeight(`URL: ${text(issue.affectedUrl) || "Not recorded"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13 })
        + wrappedHeight(issue.description || issue.explanation, CONTENT_WIDTH, { size: 10, lineHeight: 14 })
        + wrappedHeight(`Recommendation: ${text(issue.recommendation) || "Not recorded"}`, CONTENT_WIDTH, { size: 10, lineHeight: 14, bold: true })
        + 9;
      ensureSpace(issueHeight);
      label(text(issue.severity || "info"));
      writeWrapped(issue.title || issue.ruleId || "Audit finding", CONTENT_WIDTH, { size: 12, lineHeight: 16, bold: true });
      writeWrapped(`URL: ${text(issue.affectedUrl) || "Not recorded"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13, color: [89, 99, 86] });
      writeWrapped(issue.description || issue.explanation, CONTENT_WIDTH, { size: 10, lineHeight: 14 });
      writeWrapped(`Recommendation: ${text(issue.recommendation) || "Not recorded"}`, CONTENT_WIDTH, { size: 10, lineHeight: 14, bold: true });
      y += 9;
    });
  }

  heading("Pages collected");
  if (pages.length === 0) {
    writeWrapped("No pages were collected.", CONTENT_WIDTH, { color: [89, 99, 86] });
  } else {
    pages.forEach((page, index) => {
      if (index > 0) y += 7;
      const pageHeight = wrappedHeight(page.url, CONTENT_WIDTH, { size: 10, lineHeight: 14, bold: true })
        + wrappedHeight(`Status: ${text(page.statusCode) || "Not fetched"}  |  Indexing: ${page.isNoindex ? "Noindex" : "Indexable"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13 })
        + wrappedHeight(`Title: ${text(page.title) || "No title"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13 })
        + 7;
      ensureSpace(pageHeight);
      writeWrapped(page.url, CONTENT_WIDTH, { size: 10, lineHeight: 14, bold: true });
      writeWrapped(`Status: ${text(page.statusCode) || "Not fetched"}  |  Indexing: ${page.isNoindex ? "Noindex" : "Indexable"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13, color: [89, 99, 86] });
      writeWrapped(`Title: ${text(page.title) || "No title"}`, CONTENT_WIDTH, { size: 9, lineHeight: 13 });
      y += 7;
    });
  }

  const pageCount = doc.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setDrawColor(220, 228, 217);
    doc.line(MARGIN, PAGE_HEIGHT - MARGIN + 4, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - MARGIN + 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(89, 99, 86);
    doc.text(`GrowthSent - Page ${pageNumber} of ${pageCount}`, MARGIN, PAGE_HEIGHT - MARGIN + 18);
  }

  return doc;
}

export async function downloadAuditReport(scanResult: any): Promise<void> {
  const report = await createAuditReportPdf(scanResult);
  report.save(reportFilename(scanResult?.scan?.hostname));
}
