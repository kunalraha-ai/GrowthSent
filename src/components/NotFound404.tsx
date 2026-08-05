import React, { useEffect, useState } from "react";
import { Logo } from "./Logo";

interface NotFound404Props {
  onBack?: () => void;
  onScanUrl?: (url: string) => void;
}

export function NotFound404({ onBack, onScanUrl }: NotFound404Props) {
  const [inputUrl, setInputUrl] = useState("");

  useEffect(() => {
    document.title = "404: Page Not Found — GrowthSent";
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = inputUrl.trim();
    if (target && onScanUrl) {
      onScanUrl(target);
    } else if (onBack) {
      onBack();
    }
  };

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
          background: "#1a1b18",
          border: "1px solid #383a35",
          color: "#a4ef51",
          fontSize: "13px",
          fontWeight: 800,
          letterSpacing: "1px",
          marginBottom: "20px",
          textTransform: "uppercase"
        }}>
          404 ERROR
        </div>

        <h1 style={{ fontSize: "56px", fontWeight: 900, margin: "0 0 16px 0", color: "#f7f7f3", letterSpacing: "-1px" }}>
          Page Not Found
        </h1>

        <p style={{ color: "#888982", fontSize: "17px", maxWidth: "520px", margin: "0 0 36px 0", lineHeight: "1.6" }}>
          The page you are looking for doesn&apos;t exist or has been moved. But while you&apos;re here, run a free technical audit on any website:
        </p>

        {/* Domain Audit Search Bar */}
        <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: "540px", display: "flex", gap: "10px", background: "#171817", padding: "8px", borderRadius: "12px", border: "1px solid #2d2f2b" }}>
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://yourwebsite.com"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#f7f7f3",
              padding: "10px 14px",
              fontSize: "15px",
              fontFamily: "inherit"
            }}
          />
          <button
            type="submit"
            style={{
              background: "#a4ef51",
              color: "#0e0f0e",
              border: "none",
              padding: "12px 22px",
              borderRadius: "8px",
              fontWeight: 800,
              fontSize: "14px",
              cursor: "pointer",
              transition: "transform 0.15s ease",
            }}
          >
            Audit Site →
          </button>
        </form>

        <div style={{ marginTop: "32px" }}>
          <button
            onClick={onBack}
            style={{
              background: "transparent",
              border: "none",
              color: "#888982",
              fontSize: "14px",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Back to GrowthSent Home
          </button>
        </div>
      </main>
    </div>
  );
}
