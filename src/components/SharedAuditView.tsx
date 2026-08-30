import React, { useEffect, useState } from "react";
import type { PublicAuditReport } from "../../lib/audits/public-report";
import { downloadAuditReport } from "./dashboard/audit-report";

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; report: PublicAuditReport };

export function SharedAuditView({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/shared/audits/${encodeURIComponent(token)}`)
      .then(async (response) => ({ response, body: await response.json().catch(() => null) }))
      .then(({ response, body }) => {
        if (cancelled) return;
        setState(response.ok && body?.scan ? { kind: "ready", report: body as PublicAuditReport } : { kind: "missing" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "missing" });
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    document.title = state.kind === "ready"
      ? `GrowthSent audit — ${state.report.scan.hostname}`
      : "Shared GrowthSent audit";
  }, [state]);

  if (state.kind === "loading") {
    return <main style={{ maxWidth: "780px", margin: "80px auto", padding: "0 24px" }}><p>Loading shared audit…</p></main>;
  }
  if (state.kind === "missing") {
    return <main style={{ maxWidth: "780px", margin: "80px auto", padding: "0 24px" }}><h1>Shared audit unavailable</h1><p>This link is invalid, was replaced, or the report is no longer available.</p><a href="/">Go to GrowthSent</a></main>;
  }

  const { report } = state;
  const scanResult = { scan: report.scan, pages: report.pages, issues: report.issues };
  return (
    <main style={{ maxWidth: "960px", margin: "48px auto", padding: "0 24px 56px", color: "#182117" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: "20px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "28px" }}>
        <div><p style={{ color: "#557633", fontSize: "12px", fontWeight: 800, letterSpacing: ".1em", margin: "0 0 8px" }}>READ-ONLY SHARED AUDIT</p><h1 style={{ margin: 0, fontSize: "32px" }}>{report.scan.hostname}</h1><p style={{ color: "#596356" }}>A bounded technical SEO snapshot shared from GrowthSent.</p></div>
        <button className="secondary-btn" type="button" onClick={() => downloadAuditReport(scanResult)}>Download report</button>
      </header>
      <section className="metrics-grid">
        <div className="metric-card"><p className="metric-label">SEO Health Score</p><b className="metric-val">{typeof report.scan.seoScore === "number" ? `${report.scan.seoScore}%` : "—"}</b></div>
        <div className="metric-card"><p className="metric-label">Pages checked</p><b className="metric-val">{report.scan.crawlStats.totalPagesCrawled}</b></div>
        <div className="metric-card"><p className="metric-label">Issues found</p><b className="metric-val warn-text">{report.issues.length}</b></div>
      </section>
      <section className="console-section-card" style={{ marginTop: "24px" }}><div className="card-header"><h2 className="card-title">Findings</h2><p className="card-sub">Only checks and evidence from this completed audit are shown.</p></div><div style={{ padding: "0 20px 20px" }}>{report.issues.length ? report.issues.map((issue, index) => <article key={`${issue.ruleId}-${issue.affectedUrl}-${index}`} style={{ borderTop: index ? "1px solid #e6e8e2" : undefined, padding: "16px 0" }}><p className="kicker" style={{ marginBottom: "5px" }}>{issue.severity}</p><h3 style={{ margin: "0 0 8px" }}>{issue.title}</h3><p style={{ margin: "0 0 8px", overflowWrap: "anywhere" }}>{issue.affectedUrl}</p><p style={{ margin: "0 0 8px" }}>{issue.description}</p><p style={{ margin: 0 }}><strong>Recommendation:</strong> {issue.recommendation}</p></article>) : <p className="card-sub">No issues were returned by the checks collected in this audit.</p>}</div></section>
      <p style={{ color: "#596356", fontSize: "13px", marginTop: "24px" }}>This link provides a read-only report. Creating a new share link replaces it.</p>
    </main>
  );
}
