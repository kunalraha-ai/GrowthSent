import React, { useState } from "react";

interface SettingsViewProps {
  activeSite: string;
  websiteId: string | null;
  isGscConnected: boolean;
  isGaConnected: boolean;
}

export function SettingsView({
  activeSite,
  websiteId,
  isGscConnected,
  isGaConnected,
}: SettingsViewProps) {
  const [siteName, setSiteName] = useState(activeSite);
  const [timezone, setTimezone] = useState("UTC (GMT+0)");
  const [frequency, setFrequency] = useState("6h");

  return (
    <div className="settings-view">
      {/* Header Bar */}
      <div className="console-title">
        <div>
          <h3 className="title-text">Website &amp; Account Settings</h3>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", marginTop: "24px" }}>
        {/* Section 1: General */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">General</h4>
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label className="form-label">Website Name</label>
              <input
                type="text"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                className="form-input"
              />
            </div>
            <div>
              <label className="form-label">Domain Hostname</label>
              <input
                type="text"
                readOnly
                value={activeSite}
                className="form-input read-only"
              />
            </div>
            <div>
              <label className="form-label">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="form-input"
              >
                <option value="UTC (GMT+0)">UTC (GMT+0)</option>
                <option value="EST (GMT-5)">Eastern Time (EST)</option>
                <option value="PST (GMT-8)">Pacific Time (PST)</option>
                <option value="IST (GMT+5:30)">Indian Standard Time (IST)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Section 2: Monitoring */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">Monitoring</h4>
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label className="form-label">Automated Scan Frequency</label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                className="form-input"
              >
                <option value="6h">Every 6 hours</option>
                <option value="daily">Every 24 hours (Daily)</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
        </div>

        {/* Section 3: Notifications */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">Notifications</h4>
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", color: "#171817", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}>
              <input type="checkbox" defaultChecked />
              <span>Email notifications for Critical SEO issues</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", color: "#171817", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}>
              <input type="checkbox" defaultChecked />
              <span>Weekly website health summary digest</span>
            </label>
          </div>
        </div>

        {/* Section 4: Integrations */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">Connected Services</h4>
          </div>
          <div style={{ padding: "20px" }}>
            <div className="inspect-list">
              <div className="inspect-item flex-between">
                <span>Google Search Console:</span>
                <span className={`status-pill ${isGscConnected ? "healthy" : "warn"}`}>
                  {isGscConnected ? "● Connected" : "Disconnected"}
                </span>
              </div>
              <div className="inspect-item flex-between">
                <span>Google Analytics 4:</span>
                <span className={`status-pill ${isGaConnected ? "healthy" : "warn"}`}>
                  {isGaConnected ? "● Connected" : "Disconnected"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Section 5: Developer */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">Developer</h4>
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label className="form-label">API Key</label>
              <div style={{ display: "flex", gap: "10px" }}>
                <input
                  type="password"
                  readOnly
                  value="gs_live_9481a8c3d91f28b7e"
                  className="form-input read-only"
                  style={{ flex: 1 }}
                />
                <button className="secondary-btn" onClick={() => alert("API Key copied to clipboard.")}>
                  Copy Key
                </button>
              </div>
            </div>

            <div>
              <label className="form-label">MCP Server Access</label>
              <span className="badge-status pass" style={{ fontSize: "12px" }}>Active — Ready for AI agents</span>
            </div>

            <div>
              <label className="form-label">Webhook URL (Optional)</label>
              <input
                type="text"
                placeholder="https://yourserver.com/webhooks/growthsent"
                className="form-input"
              />
            </div>
          </div>
        </div>

        {/* Section 5.5: Analytics */}
        <div className="console-section-card">
          <div className="card-header">
            <h4 className="card-title">Analytics</h4>
          </div>
          <div style={{ padding: "20px" }}>
            <p style={{ color: "#73746d", fontSize: "13px", margin: 0 }}>
              Traffic and engagement data comes from Google Analytics. Connect it (and pick the right
              GA4 property) from the <strong>Google Analytics</strong> tab in the sidebar.
            </p>
          </div>
        </div>

        {/* Section 6: Danger Zone */}
        <div className="console-section-card danger-card">
          <div className="card-header">
            <h4 className="card-title" style={{ color: "#ef4444" }}>Danger Zone</h4>
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ color: "#aaaaa2", fontSize: "13px", margin: 0 }}>
              Deleting your website removes all crawled page records, audit logs, and monitoring history.
            </p>
            <div style={{ display: "flex", gap: "12px" }}>
              <button className="danger-btn" onClick={() => alert("Website deletion requested.")}>
                Delete Website
              </button>
              <button className="danger-btn" onClick={() => alert("All account data deletion requested.")}>
                Delete All Data
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
