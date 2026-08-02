import React from "react";

export function MetricSkeleton() {
  return (
    <div className="metric-card skeleton-card">
      <div className="skeleton-line" style={{ width: "40%", height: "12px", marginBottom: "12px" }} />
      <div className="skeleton-line" style={{ width: "65%", height: "28px", marginBottom: "10px" }} />
      <div className="skeleton-line" style={{ width: "80%", height: "10px" }} />
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="overview-skeleton" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* 4 Metrics Row */}
      <div className="metrics-grid">
        <MetricSkeleton />
        <MetricSkeleton />
        <MetricSkeleton />
        <MetricSkeleton />
      </div>

      {/* Issues Card Skeleton */}
      <div className="console-section-card" style={{ padding: "24px" }}>
        <div className="skeleton-line" style={{ width: "30%", height: "20px", marginBottom: "16px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div className="skeleton-line" style={{ width: "100%", height: "48px", borderRadius: "8px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "48px", borderRadius: "8px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "48px", borderRadius: "8px" }} />
        </div>
      </div>

      {/* Grid Row Skeleton */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <div className="console-section-card" style={{ padding: "24px", height: "220px" }}>
          <div className="skeleton-line" style={{ width: "40%", height: "18px", marginBottom: "20px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "120px", borderRadius: "10px" }} />
        </div>
        <div className="console-section-card" style={{ padding: "24px", height: "220px" }}>
          <div className="skeleton-line" style={{ width: "50%", height: "18px", marginBottom: "20px" }} />
          <div className="skeleton-line" style={{ width: "100%", height: "120px", borderRadius: "10px" }} />
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="console-section-card" style={{ padding: "24px" }}>
      <div className="skeleton-line" style={{ width: "35%", height: "20px", marginBottom: "20px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton-line" style={{ width: "100%", height: "40px", borderRadius: "6px" }} />
        ))}
      </div>
    </div>
  );
}
