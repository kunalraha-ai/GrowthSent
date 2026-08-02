import React from "react";

export type SeverityLevel = "critical" | "high" | "warning" | "medium" | "low" | "pass";

export function SeverityIcon({ level, size = 18 }: { level: SeverityLevel; size?: number }) {
  switch (level) {
    case "critical":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M12 2L2 22H22L12 2Z"
            fill="#FEE2E2"
            stroke="#DC2626"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path d="M12 9V14" stroke="#DC2626" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="12" cy="17" r="1.25" fill="#DC2626" />
        </svg>
      );

    case "high":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" fill="#FFEDD5" stroke="#C2410C" strokeWidth="2" />
          <path d="M12 7V13" stroke="#C2410C" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="1.25" fill="#C2410C" />
        </svg>
      );

    case "warning":
    case "medium":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M12 3L21 8.5V15.5L12 21L3 15.5V8.5L12 3Z"
            fill="#FFFBE6"
            stroke="#D87D00"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.5" fill="#D87D00" />
        </svg>
      );

    case "low":
    case "pass":
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" fill="#E8F5E9" stroke="#2E7D32" strokeWidth="2" />
          <path
            d="M8.5 12.5L11 15L15.5 9.5"
            stroke="#2E7D32"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

export function SeverityBadge({ level, showText = true }: { level: SeverityLevel; showText?: boolean }) {
  const getLabel = () => {
    switch (level) {
      case "critical": return "Critical";
      case "high": return "High";
      case "warning":
      case "medium": return "Warning";
      case "low": return "Low";
      case "pass": return "Pass";
    }
  };

  const getColor = () => {
    switch (level) {
      case "critical": return "#dc2626";
      case "high": return "#c2410c";
      case "warning":
      case "medium": return "#d87d00";
      case "low":
      case "pass": return "#2e7d32";
    }
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <SeverityIcon level={level} size={18} />
      {showText && (
        <span
          style={{
            fontFamily: "'Google Sans', 'Roboto', sans-serif",
            fontSize: "12px",
            fontWeight: 700,
            color: getColor(),
            textTransform: "capitalize",
          }}
        >
          {getLabel()}
        </span>
      )}
    </div>
  );
}
