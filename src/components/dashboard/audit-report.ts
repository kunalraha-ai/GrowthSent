import { isAuditResultEvaluable } from "./audit-evidence";

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function escapeHtml(value: unknown): string {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function dateLabel(value: unknown): string {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function reportFilename(hostname: unknown): string {
  const safeHost = text(hostname).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "website";
  return `growthsent-audit-${safeHost}.html`;
}

/** Builds a self-contained, readable HTML report from the current audit data. */
export function buildAuditReportHtml(scanResult: any): string {
  const scan = scanResult?.scan;
  if (!scan) throw new Error("A completed audit is required to create a report.");
  const pages: any[] = Array.isArray(scanResult?.pages) ? scanResult.pages : [];
  const issues: any[] = Array.isArray(scanResult?.issues) ? scanResult.issues : [];
  const evaluable = isAuditResultEvaluable(scanResult);
  const score = evaluable && typeof scan.seoScore === "number" ? `${scan.seoScore}%` : "Not evaluated";
  const pageRows = pages.map((page) => `<tr><td>${escapeHtml(page.url)}</td><td>${escapeHtml(page.statusCode || "Not fetched")}</td><td>${escapeHtml(page.title || "No title")}</td><td>${escapeHtml(page.isNoindex ? "Noindex" : "Indexable")}</td></tr>`).join("");
  const issueRows = issues.map((issue) => `<article class="issue"><p class="severity">${escapeHtml(issue.severity || "info")}</p><h3>${escapeHtml(issue.title || issue.ruleId || "Audit finding")}</h3><p><strong>URL:</strong> ${escapeHtml(issue.affectedUrl)}</p><p>${escapeHtml(issue.description || issue.explanation)}</p><p><strong>Recommendation:</strong> ${escapeHtml(issue.recommendation)}</p></article>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GrowthSent audit — ${escapeHtml(scan.hostname)}</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182117;line-height:1.5;max-width:920px;margin:40px auto;padding:0 24px;background:#fff}h1{margin-bottom:4px}.muted{color:#596356}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:24px 0}.card,.issue{border:1px solid #dce4d9;border-radius:12px;padding:16px;background:#fbfdf9}.label,.severity{text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;color:#557633;margin:0 0 8px}.value{font-size:28px;font-weight:800;margin:0}table{width:100%;border-collapse:collapse;font-size:14px;overflow-wrap:anywhere}th,td{text-align:left;border-bottom:1px solid #e5e9e2;padding:10px;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#596356}.issue{margin:12px 0}.issue h3{margin:0 0 8px}.issue p{margin:8px 0}@media print{body{margin:0;max-width:none}.card,.issue{break-inside:avoid}}</style></head>
<body><header><p class="label">GrowthSent technical SEO audit</p><h1>${escapeHtml(scan.hostname)}</h1><p class="muted">Completed ${escapeHtml(dateLabel(scan.completionTime || scan.createdAt))}. This report contains only evidence collected by this bounded audit.</p></header>
<section class="grid"><div class="card"><p class="label">SEO Health Score</p><p class="value">${escapeHtml(score)}</p></div><div class="card"><p class="label">Pages checked</p><p class="value">${escapeHtml(scan.crawlStats?.totalPagesCrawled ?? pages.length)}</p></div><div class="card"><p class="label">Findings</p><p class="value">${escapeHtml(issues.length)}</p></div></section>
<section><h2>Findings</h2>${issueRows || "<p>No issues were returned by the checks collected in this audit.</p>"}</section>
<section><h2>Pages collected</h2>${pageRows ? `<table><thead><tr><th>URL</th><th>Status</th><th>Title</th><th>Indexing</th></tr></thead><tbody>${pageRows}</tbody></table>` : "<p>No pages were collected.</p>"}</section>
</body></html>`;
}

export function downloadAuditReport(scanResult: any): void {
  const html = buildAuditReportHtml(scanResult);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = reportFilename(scanResult?.scan?.hostname);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
