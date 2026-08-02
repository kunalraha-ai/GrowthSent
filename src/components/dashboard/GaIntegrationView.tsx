import React, { useEffect, useState } from "react";

interface GaIntegrationViewProps {
  isGaConnected: boolean;
  websiteId: string | null;
  onConnectionChanged: (isConnected: boolean) => void;
}

interface Ga4Property {
  propertyId: string;
  displayName: string;
  accountName: string;
}

export function GaIntegrationView({ isGaConnected, websiteId, onConnectionChanged }: GaIntegrationViewProps) {
  const [error, setError] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [selectedPropertyName, setSelectedPropertyName] = useState<string | null>(null);
  const [properties, setProperties] = useState<Ga4Property[]>([]);
  const [isLoadingProperties, setIsLoadingProperties] = useState(false);
  const [pickerChoice, setPickerChoice] = useState("");
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (!websiteId || !isGaConnected) {
      setSelectedPropertyId(null);
      setSelectedPropertyName(null);
      return;
    }

    async function loadStatus() {
      try {
        const response = await fetch(`/api/v1/integrations?websiteId=${websiteId}&provider=google_analytics`);
        const data = await response.json();
        if (response.ok) {
          setSelectedPropertyId(data.ga4PropertyId || null);
          setSelectedPropertyName(data.ga4PropertyDisplayName || null);
          if (!data.ga4PropertyId) loadProperties();
        }
      } catch {
        // Non-fatal — the connect/property UI will still function.
      }
    }
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [websiteId, isGaConnected]);

  const loadProperties = async () => {
    if (!websiteId) return;
    setIsLoadingProperties(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ga4-properties?websiteId=${websiteId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Unable to load Google Analytics properties.");
      setProperties(data.properties || []);
      setShowPicker(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Google Analytics properties.");
    } finally {
      setIsLoadingProperties(false);
    }
  };

  const selectProperty = async () => {
    if (!websiteId || !pickerChoice) return;
    const chosen = properties.find((p) => p.propertyId === pickerChoice);
    setError("");
    setIsWorking(true);
    try {
      const response = await fetch("/api/v1/ga4-properties/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteId, propertyId: pickerChoice, displayName: chosen?.displayName }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error?.message || "Unable to save the selected property.");
      setSelectedPropertyId(pickerChoice);
      setSelectedPropertyName(chosen?.displayName || pickerChoice);
      setShowPicker(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the selected property.");
    } finally {
      setIsWorking(false);
    }
  };

  const connect = async () => {
    if (!websiteId) {
      setError("Add a website before connecting Google Analytics.");
      return;
    }
    setError("");
    setIsWorking(true);
    try {
      const response = await fetch(
        `/api/v1/integrations/google/start?websiteId=${websiteId}&provider=google_analytics`
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
        `/api/v1/integrations?websiteId=${websiteId}&provider=google_analytics`,
        { method: "DELETE" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error?.message || "Unable to disconnect Google Analytics.");
      onConnectionChanged(false);
      setSelectedPropertyId(null);
      setSelectedPropertyName(null);
      setShowPicker(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect Google Analytics.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="ga-integration-view">
      <div className="console-title flex-between">
        <h3 className="title-text">Google Analytics</h3>
        <span className={`status-pill ${isGaConnected ? "healthy" : "warn"}`}>
          {isGaConnected ? "● Connected" : "Disconnected"}
        </span>
      </div>

      <div className="console-section-card" style={{ marginTop: "24px", padding: "24px" }}>
        <h4 className="card-title">Authorize Google Analytics access</h4>
        <p className="card-sub" style={{ marginTop: "8px", maxWidth: "680px" }}>
          Connect a GA4 property to pull real traffic, engagement, and channel data directly from
          Google Analytics into this dashboard.
        </p>
        {error && <p role="alert" style={{ color: "#b42318", marginTop: "16px" }}>{error}</p>}

        {!isGaConnected && (
          <div style={{ marginTop: "24px" }}>
            <button className="primary-btn" onClick={connect} disabled={isWorking || !websiteId}>
              {isWorking ? "Opening Google..." : "Connect Google Analytics →"}
            </button>
          </div>
        )}

        {isGaConnected && selectedPropertyId && !showPicker && (
          <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div className="inspect-item flex-between" style={{ maxWidth: "480px" }}>
              <span>GA4 Property:</span>
              <span style={{ fontWeight: 700 }}>{selectedPropertyName || selectedPropertyId}</span>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button className="secondary-btn" onClick={loadProperties} disabled={isLoadingProperties}>
                {isLoadingProperties ? "Loading..." : "Change Property"}
              </button>
              <button className="danger-btn" onClick={disconnect} disabled={isWorking}>
                {isWorking ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        )}

        {isGaConnected && (showPicker || !selectedPropertyId) && (
          <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "12px", maxWidth: "480px" }}>
            {isLoadingProperties ? (
              <p className="card-sub">Loading your Google Analytics properties...</p>
            ) : properties.length === 0 ? (
              <p className="card-sub">
                No GA4 properties were found on this Google account. Make sure you selected the correct
                account when authorizing, and that it has at least one GA4 property.
              </p>
            ) : (
              <>
                <label className="form-label">Select the GA4 property for this website</label>
                <select
                  className="form-input"
                  value={pickerChoice}
                  onChange={(e) => setPickerChoice(e.target.value)}
                >
                  <option value="">Choose a property...</option>
                  {properties.map((p) => (
                    <option key={p.propertyId} value={p.propertyId}>
                      {p.accountName} — {p.displayName} ({p.propertyId})
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: "10px" }}>
                  <button className="primary-btn" onClick={selectProperty} disabled={!pickerChoice || isWorking}>
                    {isWorking ? "Saving..." : "Save Property"}
                  </button>
                  {selectedPropertyId && (
                    <button className="secondary-btn" onClick={() => setShowPicker(false)}>
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
            <button className="danger-btn" onClick={disconnect} disabled={isWorking} style={{ alignSelf: "flex-start" }}>
              {isWorking ? "Disconnecting..." : "Disconnect Google Analytics"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
