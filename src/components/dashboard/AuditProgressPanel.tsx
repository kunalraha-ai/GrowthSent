import React from "react";
import { auditProgressDescription, type AuditProgress } from "./audit-status";

const STAGES = ["queued", "crawling", "analysing"] as const;

function stageIndex(status: AuditProgress["status"]): number {
  const index = STAGES.indexOf(status as (typeof STAGES)[number]);
  return index < 0 ? 0 : index;
}

export function AuditProgressPanel({ progress }: { progress: AuditProgress }) {
  const currentStage = stageIndex(progress.status);
  const copy = auditProgressDescription(progress);

  return (
    <section
      aria-live="polite"
      className="console-section-card"
      style={{ marginTop: "20px", padding: "24px", border: "1px solid #cde9b4", background: "#fbfff7" }}
    >
      <p className="kicker" style={{ color: "#4b7d1e", marginBottom: "6px" }}>LIVE AUDIT STATUS</p>
      <h4 className="card-title" style={{ marginBottom: "6px" }}>{copy.title}</h4>
      <p className="card-sub" style={{ maxWidth: "620px" }}>{copy.detail}</p>
      <ol
        aria-label="Audit stages"
        style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px", listStyle: "none", padding: 0, margin: "20px 0 0" }}
      >
        {STAGES.map((stage, index) => {
          const complete = index < currentStage;
          const current = index === currentStage;
          const label = stage === "queued" ? "Accepted" : stage === "crawling" ? "Crawling" : "Analysing";
          return (
            <li
              key={stage}
              style={{ padding: "10px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 700, border: `1px solid ${current ? "#7bbf42" : complete ? "#b8dd91" : "#e2e4dd"}`, color: current ? "#315b10" : complete ? "#537d2a" : "#767871", background: current ? "#eefbe3" : complete ? "#f7fff1" : "#fff" }}
            >
              <span aria-hidden="true">{complete ? "✓" : current ? "●" : "○"}</span> {label}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
