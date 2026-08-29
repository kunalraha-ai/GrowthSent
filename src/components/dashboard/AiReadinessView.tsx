import React, { useCallback, useEffect, useState } from "react";

type AiReadinessStatus = "ready" | "needs_attention" | "unavailable";

interface ReadinessCheck {
  id: string;
  group: string;
  title: string;
  description: string;
  priority: "High impact" | "Foundation" | "Advanced";
  weight: number;
  status: AiReadinessStatus;
  evidence: string;
  recommendation: string;
}

interface AiReadinessReport {
  kind: "growthsent-ai-readiness-report";
  generatedAt: string;
  target: { url: string; hostname: string };
  score: {
    value: number | null;
    coveragePercent: number;
    observedWeight: number;
    totalWeight: number;
  };
  summary: {
    ready: number;
    needsAttention: number;
    unavailable: number;
  };
  checks: ReadinessCheck[];
}

interface AiReadinessViewProps {
  activeSite: string;
  websiteId: string | null;
}

const STATUS_COPY: Record<AiReadinessStatus, { label: string; symbol: string; className: string }> = {
  ready: { label: "Ready", symbol: "✓", className: "ready" },
  needs_attention: { label: "Needs attention", symbol: "!", className: "attention" },
  unavailable: { label: "Could not verify", symbol: "—", className: "unavailable" },
};

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The AI readiness audit could not be completed. Please try again.";
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function scoreMeterMessage(score: number | null): string {
  if (score === null) return "Not scored yet";
  if (score < 25) return "Meh!";
  if (score < 50) return "Getting Somewhere";
  if (score < 75) return "Why not 100?";
  return "That's more like it";
}

function CheckStatusBadge({ status }: { status: AiReadinessStatus }) {
  const copy = STATUS_COPY[status];
  return (
    <span className={`ai-readiness-status ai-readiness-status-${copy.className}`}>
      <span aria-hidden="true">{copy.symbol}</span>
      {copy.label}
    </span>
  );
}

function CheckRow({ check, expanded, onToggle }: { check: ReadinessCheck; expanded: boolean; onToggle: () => void }) {
  const copy = STATUS_COPY[check.status];
  const priorityClass = check.priority.toLowerCase().replace(" ", "-");
  return (
    <article className={`ai-readiness-check ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="ai-readiness-check-summary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`${check.id}-details`}
      >
        <span className={`ai-readiness-check-icon ai-readiness-check-icon-${copy.className}`} aria-hidden="true">{copy.symbol}</span>
        <span className="ai-readiness-check-title">
          <strong>{check.title}</strong>
          <span>{check.description}</span>
        </span>
        <span className={`ai-readiness-impact ai-readiness-impact-${priorityClass}`}>{check.priority}</span>
        <CheckStatusBadge status={check.status} />
        <span className="ai-readiness-expand" aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>

      {expanded ? (
        <div className="ai-readiness-check-details" id={`${check.id}-details`}>
          <div>
            <span className="ai-readiness-detail-label">Observed evidence</span>
            <p>{check.evidence}</p>
          </div>
          <span className="ai-readiness-text-action">{check.recommendation}</span>
        </div>
      ) : null}
    </article>
  );
}

function EmptyAiReadinessState({ activeSite }: { activeSite: string }) {
  return (
    <section className="console-section-card ai-readiness-empty-state">
      <div className="empty-icon-circle" aria-hidden="true">✦</div>
      <h4>{activeSite ? "Choose a saved website to run this audit" : "Add a website to run an AI readiness audit"}</h4>
      <p>AI readiness audits run only for a saved website you own. They inspect public, same-origin documents and do not use sample data.</p>
    </section>
  );
}

export default function AiReadinessView({ activeSite, websiteId }: AiReadinessViewProps) {
  const [report, setReport] = useState<AiReadinessReport | null>(null);
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runAudit = useCallback(async (signal?: AbortSignal) => {
    if (!websiteId) {
      setReport(null);
      setError("");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch(`/api/v1/websites/${websiteId}/ai-readiness`, { method: "POST", signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "The AI readiness audit could not be completed. Please try again.");
      if (payload?.kind !== "growthsent-ai-readiness-report" || !Array.isArray(payload.checks)) {
        throw new Error("The AI readiness audit returned an invalid report.");
      }
      if (!signal?.aborted) {
        setReport(payload as AiReadinessReport);
        setExpandedCheck(payload.checks[0]?.id || null);
      }
    } catch (caught) {
      if (!signal?.aborted) {
        setReport(null);
        setError(toErrorMessage(caught));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => {
    const controller = new AbortController();
    void runAudit(controller.signal);
    return () => controller.abort();
  }, [runAudit]);

  const siteName = activeSite || "your website";
  const groups = report ? Array.from(report.checks.reduce((map, check) => {
    const items = map.get(check.group) || [];
    items.push(check);
    map.set(check.group, items);
    return map;
  }, new Map<string, ReadinessCheck[]>()).entries()) : [];
  const priority = report?.checks.reduce<ReadinessCheck | null>((best, check) => {
    if (check.status !== "needs_attention") return best;
    return !best || check.weight > best.weight ? check : best;
  }, null) || null;
  const scoreValue = report?.score.value ?? null;
  const scorePercent = scoreValue === null ? 0 : Math.max(0, Math.min(100, scoreValue));
  const scoreMessage = scoreMeterMessage(scoreValue);

  return (
    <div className="ai-readiness-view">
      <header className="console-title flex-between ai-readiness-header">
        <div>
          <p className="ai-readiness-kicker">AI READINESS AUDIT <span>LIVE</span></p>
          <h3 className="title-text">Make {siteName} easier for AI agents to find and use</h3>
          <p className="ai-readiness-description">A bounded live check of public, same-origin documents. Results are evidence-backed and are not saved as fabricated demo data.</p>
        </div>
        <div className="ai-readiness-header-actions">
          {report ? <span className="ai-readiness-preview-pill">Checked {formatGeneratedAt(report.generatedAt)}</span> : null}
          <button type="button" className="secondary-btn" onClick={() => void runAudit()} disabled={!websiteId || loading}>
            {loading ? "Checking AI readiness..." : "Run AI readiness audit"}
          </button>
        </div>
      </header>

      {!websiteId ? <EmptyAiReadinessState activeSite={activeSite} /> : null}

      {websiteId && loading ? (
        <section className="console-section-card ai-readiness-empty-state" aria-live="polite">
          <div className="empty-icon-circle ai-readiness-loading-mark" aria-hidden="true">⋯</div>
          <h4>Checking public AI readiness signals</h4>
          <p>Inspecting the homepage, robots.txt, sitemap discovery, llms.txt, and supported agent-action discovery documents.</p>
        </section>
      ) : null}

      {websiteId && error ? (
        <section className="console-section-card ai-readiness-empty-state ai-readiness-error-state" role="alert">
          <div className="empty-icon-circle" aria-hidden="true">!</div>
          <h4>AI readiness audit unavailable</h4>
          <p>{error}</p>
          <button type="button" className="primary-btn" onClick={() => void runAudit()}>Try again</button>
        </section>
      ) : null}

      {report ? (
        <>
          <section className="ai-readiness-live-notice" aria-label="Report methodology">
            <span aria-hidden="true">✦</span>
            <p><strong>{report.score.coveragePercent}% evidence coverage.</strong> Unavailable documents are excluded from the score instead of being treated as failures.</p>
          </section>

          <section className="ai-readiness-hero-grid" aria-label="AI readiness summary">
            <article className="ai-readiness-score-card">
              <div>
                <p className="ai-readiness-card-kicker">READINESS SCORE</p>
                <div className="ai-readiness-score-line">
                  <strong>{report.score.value ?? "—"}</strong><span>{report.score.value === null ? "not scored" : "/100"}</span>
                </div>
                <p>{report.score.value === null ? "No checks could be safely verified for this website." : `Calculated from ${report.score.observedWeight} of ${report.score.totalWeight} available evidence weight.`}</p>
              </div>
              <div
                className="ai-readiness-score-gauge"
                role="img"
                aria-label={`AI readiness score ${scoreValue ?? "not scored"} out of 100: ${scoreMessage}`}
              >
                <svg viewBox="0 0 180 106" aria-hidden="true">
                  <path className="ai-readiness-score-gauge-track" d="M 18 88 A 72 72 0 0 1 162 88" pathLength="100" />
                  <path
                    className="ai-readiness-score-gauge-fill"
                    d="M 18 88 A 72 72 0 0 1 162 88"
                    pathLength="100"
                    strokeDasharray={`${scorePercent} 100`}
                  />
                </svg>
                <div className="ai-readiness-score-gauge-value">
                  <strong>{scoreValue ?? "—"}</strong>
                  <span>{scoreValue === null ? "not scored" : "/100"}</span>
                </div>
                <span className="ai-readiness-score-gauge-label">{scoreMessage}</span>
              </div>
            </article>

            <article className="ai-readiness-priority-card">
              <div className="ai-readiness-priority-label"><span aria-hidden="true">↗</span> {priority ? "Highest-impact next step" : "Current result"}</div>
              <h4>{priority?.title || "No confirmed attention items"}</h4>
              <p>{priority ? priority.recommendation : "Every currently available check passed. Review unavailable checks before treating this as complete coverage."}</p>
              <div className="ai-readiness-priority-tags">
                <span>{priority?.priority || `${report.summary.ready} checks ready`}</span>
                <span>{report.target.hostname}</span>
              </div>
            </article>
          </section>

          <section className="metrics-grid ai-readiness-metrics" aria-label="AI readiness status counts">
            <article className="metric-card">
              <p className="metric-label">Ready</p>
              <b className="metric-val pass-text">{report.summary.ready}</b>
              <span className="metric-sub text-muted">verified public signals</span>
            </article>
            <article className="metric-card">
              <p className="metric-label">Needs attention</p>
              <b className="metric-val warn-text">{report.summary.needsAttention}</b>
              <span className="metric-sub text-muted">confirmed missing or weak signals</span>
            </article>
            <article className="metric-card">
              <p className="metric-label">Could not verify</p>
              <b className="metric-val info-text">{report.summary.unavailable}</b>
              <span className="metric-sub text-muted">excluded from the score</span>
            </article>
            <article className="metric-card">
              <p className="metric-label">Evidence coverage</p>
              <b className="metric-val">{report.score.coveragePercent}%</b>
              <span className="metric-sub text-muted">of weighted checks observed</span>
            </article>
          </section>

          <section className="ai-readiness-layout">
            <div className="ai-readiness-check-groups">
              {groups.map(([group, checks], index) => (
                <section className="console-section-card ai-readiness-group" key={group}>
                  <div className="card-header ai-readiness-group-header">
                    <div>
                      <span className="ai-readiness-section-number">{String(index + 1).padStart(2, "0")}</span>
                      <h4 className="card-title">{group}</h4>
                    </div>
                    <p className="card-sub">{checks.length} evidence-backed checks</p>
                  </div>
                  <div className="ai-readiness-check-list">
                    {checks.map((check) => (
                      <CheckRow
                        key={check.id}
                        check={check}
                        expanded={expandedCheck === check.id}
                        onToggle={() => setExpandedCheck((current) => current === check.id ? null : check.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <aside className="ai-readiness-side-panel">
              <section className="console-section-card ai-readiness-next-card">
                <div className="card-header">
                  <h4 className="card-title">How this report was scored</h4>
                  <p className="card-sub">Observed evidence only</p>
                </div>
                <ol className="ai-readiness-deliverables">
                  <li><span>1</span><div><strong>Fetch safely</strong><p>Every public document is fetched through the app’s SSRF guard and bounded response reader.</p></div></li>
                  <li><span>2</span><div><strong>Verify exactly</strong><p>A check passes only when its required document or markup was actually observed.</p></div></li>
                  <li><span>3</span><div><strong>Score fairly</strong><p>Timeouts and unavailable documents lower coverage, but never become invented failures.</p></div></li>
                </ol>
              </section>

              <section className="ai-readiness-definition-card">
                <span className="ai-readiness-definition-icon" aria-hidden="true">?</span>
                <div>
                  <strong>What “AI ready” means</strong>
                  <p>AI readiness reflects technical discoverability, usable content, trusted identity, and safe actions. It does not guarantee citations, traffic, or model recommendations.</p>
                </div>
              </section>
            </aside>
          </section>
        </>
      ) : null}
    </div>
  );
}
