import React, { useState } from "react";

interface GscIntegrationViewProps {
  isGscConnected: boolean;
  websiteId: string | null;
  onConnectionChanged: (isConnected: boolean) => void;
}

export function GscIntegrationView({
  isGscConnected,
  websiteId,
  onConnectionChanged,
}: GscIntegrationViewProps) {
  const [error, setError] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  const connect = async () => {
    if (!websiteId) {
      setError("Add a website before connecting Google Search Console.");
      return;
    }
    setError("");
    setIsWorking(true);
    try {
      const response = await fetch(
        `/api/v1/integrations/google/start?websiteId=${websiteId}&provider=google_search_console`
      );
      const data = await response.json();
      if (!response.ok || !data.authorizationUrl) throw new Error(data.error?.message || "Unable to start Google OAuth.");
      window.location.assign(data.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Google OAuth.");
      setIsWorking(false);
    }
  };

  const disconnect = async () => {
    if (!websiteId) return;
    setError("");
    setIsWorking(true);
    try {
      const response = await fetch(
        `/api/v1/integrations?websiteId=${websiteId}&provider=google_search_console`,
        { method: "DELETE" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error?.message || "Unable to disconnect Google Search Console.");
      onConnectionChanged(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect Google Search Console.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="gsc-integration-view">
      <div className="console-title flex-between">
        <h3 className="title-text">Google Search Console</h3>
        <span className={`status-pill ${isGscConnected ? "healthy" : "warn"}`}>
          {isGscConnected ? "● Connected" : "Disconnected"}
        </span>
      </div>

      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px" }}>
        <h4 className="card-title">Search visibility data</h4>
        <p className="card-sub" style={{ marginTop: "8px", maxWidth: "680px" }}>
          Connect the Google account that has access to this website’s Search Console property. GrowthSent stores the returned tokens encrypted and uses them only to retrieve your search performance data.
        </p>
        {error && <p role="alert" style={{ color: "#b42318", marginTop: "16px" }}>{error}</p>}

        <div style={{ marginTop: "24px", display: "flex", gap: "12px", alignItems: "center" }}>
          {isGscConnected ? (
            <button className="danger-btn" onClick={disconnect} disabled={isWorking}>
              {isWorking ? "Disconnecting..." : "Disconnect Google Search Console"}
            </button>
          ) : (
            <button className="primary-btn" onClick={connect} disabled={isWorking || !websiteId}>
              {isWorking ? "Opening Google..." : "Connect Google Search Console →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
