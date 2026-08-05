import React, { useEffect } from "react";
import { Logo } from "./Logo";

interface ServerError500Props {
  onBack?: () => void;
  onRetry?: () => void;
  errorDetails?: string;
}

export function ServerError500({ onBack, onRetry, errorDetails }: ServerError500Props) {
  useEffect(() => {
    document.title = "500: Server Error — GrowthSent";
  }, []);

  return (
    <div style={{ background: "#0e0f0e", color: "#f7f7f3", minHeight: "100vh", fontFamily: "'Inter', sans-serif", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header style={{
        borderBottom: "1px solid #232521",
        padding: "18px 32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        maxWidth: "1100px",
        width: "100%",
        margin: "0 auto",
        boxSizing: "border-box",
      }}>
        <div style={{ cursor: "pointer" }} onClick={onBack}>
          <Logo dark />
        </div>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: "#1f201d",
              color: "#a4ef51",
              border: "1px solid #383a35",
              padding: "8px 16px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            ← Return to GrowthSent
          </button>
        )}
      </header>

      {/* Main Content */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center" }}>
        <div style={{
          display: "inline-block",
          padding: "6px 16px",
          borderRadius: "20px",
          background: "rgba(239, 68, 68, 0.1)",
          border: "1px solid rgba(239, 68, 68, 0.3)",
          color: "#f87171",
          fontSize: "13px",
          fontWeight: 800,
          letterSpacing: "1px",
          marginBottom: "20px",
          textTransform: "uppercase"
        }}>
          500 SERVER ERROR
        </div>

        <h1 style={{ fontSize: "56px", fontWeight: 900, margin: "0 0 16px 0", color: "#f7f7f3", letterSpacing: "-1px" }}>
          Something went wrong
        </h1>

        <p style={{ color: "#888982", fontSize: "17px", maxWidth: "520px", margin: "0 0 28px 0", lineHeight: "1.6" }}>
          We encountered an internal error while processing your request. Please try refreshing or return to the dashboard.
        </p>

        {errorDetails && (
          <div style={{
            background: "#171817",
            border: "1px solid #2d2f2b",
            borderRadius: "8px",
            padding: "12px 18px",
            fontFamily: "monospace",
            fontSize: "13px",
            color: "#f87171",
            marginBottom: "32px",
            maxWidth: "600px",
            wordBreak: "break-word"
          }}>
            {errorDetails}
          </div>
        )}

        <div style={{ display: "flex", gap: "14px" }}>
          <button
            onClick={() => onRetry ? onRetry() : window.location.reload()}
            style={{
              background: "#a4ef51",
              color: "#0e0f0e",
              border: "none",
              padding: "12px 24px",
              borderRadius: "8px",
              fontWeight: 800,
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            Try Again ↻
          </button>
          {onBack && (
            <button
              onClick={onBack}
              style={{
                background: "#1f201d",
                color: "#f7f7f3",
                border: "1px solid #383a35",
                padding: "12px 24px",
                borderRadius: "8px",
                fontWeight: 700,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              Return Home
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
