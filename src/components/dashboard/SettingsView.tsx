import React, { useState } from "react";
import { ConfirmModal } from "../ConfirmModal";

export interface WebsiteItem {
  _id?: string;
  hostname: string;
  displayName?: string;
}

interface SettingsViewProps {
  activeSite: string;
  websiteId: string | null;
  websites?: WebsiteItem[];
  onSelectWebsite?: (site: WebsiteItem) => void;
  onAddSite?: () => void;
  isGscConnected: boolean;
  isGaConnected: boolean;
  onWebsiteDeleted?: (deletedWebsiteId: string) => void;
  onAccountDeleted?: () => void;
}

export function SettingsView({
  activeSite,
  websiteId,
  websites = [],
  onSelectWebsite,
  onAddSite,
  isGscConnected,
  isGaConnected,
  onWebsiteDeleted,
  onAccountDeleted,
}: SettingsViewProps) {
  const [siteName, setSiteName] = useState(activeSite);
  const [timezone, setTimezone] = useState("UTC (GMT+0)");

  // Target website for delete modal
  const [targetSiteToDelete, setTargetSiteToDelete] = useState<WebsiteItem | null>(null);

  // Modal states for Danger Zone actions
  const [showDeleteWebsiteModal, setShowDeleteWebsiteModal] = useState(false);
  const [isDeletingWebsite, setIsDeletingWebsite] = useState(false);
  const [deleteWebsiteError, setDeleteWebsiteError] = useState("");

  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  const handleConfirmDeleteWebsite = async () => {
    const idToDelete = targetSiteToDelete?._id || websiteId;
    if (!idToDelete) return;
    setIsDeletingWebsite(true);
    setDeleteWebsiteError("");
    try {
      const response = await fetch(`/api/v1/websites/${idToDelete}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || "Failed to delete website.");
      }
      setShowDeleteWebsiteModal(false);
      setTargetSiteToDelete(null);
      if (onWebsiteDeleted) {
        onWebsiteDeleted(idToDelete);
      }
    } catch (cause) {
      setDeleteWebsiteError(cause instanceof Error ? cause.message : "Failed to delete website.");
    } finally {
      setIsDeletingWebsite(false);
    }
  };

  const handleConfirmDeleteAccount = async () => {
    setIsDeletingAccount(true);
    setDeleteAccountError("");
    try {
      const response = await fetch("/api/v1/auth/account", {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || "Failed to delete account data.");
      }
      setShowDeleteAccountModal(false);
      if (onAccountDeleted) {
        onAccountDeleted();
      }
    } catch (cause) {
      setDeleteAccountError(cause instanceof Error ? cause.message : "Failed to delete account data.");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <div className="settings-view">
      {/* Header Bar */}
      <div className="console-title">
        <div>
          <h3 className="title-text">Website &amp; Account Settings</h3>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", marginTop: "24px" }}>
        {/* Section: Your Websites & Add Website */}
        <div className="console-section-card">
          <div className="card-header flex-between" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 className="card-title">Your Websites</h4>
              <p className="card-sub" style={{ marginTop: "4px" }}>
                Manage websites connected to your GrowthSent account.
              </p>
            </div>
            {onAddSite && (
              <button
                className="primary-btn"
                onClick={onAddSite}
                style={{ padding: "8px 16px", fontSize: "13px" }}
              >
                + Add Website
              </button>
            )}
          </div>
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {websites && websites.length > 0 ? (
              websites.map((site) => {
                const isActive = site.hostname === activeSite;
                return (
                  <div
                    key={site.hostname}
                    className="inspect-item flex-between"
                    style={{
                      padding: "12px 16px",
                      borderRadius: "8px",
                      background: isActive ? "#f7f7f3" : "transparent",
                      border: isActive ? "1px solid #e5e7eb" : "1px solid #f3f4f6",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "16px" }}>🌐</span>
                      <span style={{ fontWeight: 700, fontSize: "14px", color: "#171817" }}>
                        {site.hostname}
                      </span>
                      {isActive && (
                        <span className="status-pill healthy" style={{ fontSize: "11px", padding: "2px 8px" }}>
                          ● Active
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      {!isActive && onSelectWebsite && (
                        <button
                          className="secondary-btn"
                          style={{ padding: "6px 14px", fontSize: "12px" }}
                          onClick={() => onSelectWebsite(site)}
                        >
                          Switch
                        </button>
                      )}
                      <button
                        className="danger-btn"
                        style={{ padding: "6px 12px", fontSize: "12px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca" }}
                        title={`Delete ${site.hostname}`}
                        onClick={() => {
                          setTargetSiteToDelete(site);
                          setShowDeleteWebsiteModal(true);
                        }}
                      >
                        🗑 Delete
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="card-sub">No websites added yet.</p>
            )}
          </div>
        </div>
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
            {deleteWebsiteError && (
              <p role="alert" style={{ color: "#ef4444", fontSize: "13px", margin: 0, fontWeight: 600 }}>
                {deleteWebsiteError}
              </p>
            )}
            {deleteAccountError && (
              <p role="alert" style={{ color: "#ef4444", fontSize: "13px", margin: 0, fontWeight: 600 }}>
                {deleteAccountError}
              </p>
            )}
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                className="danger-btn"
                onClick={() => {
                  setDeleteWebsiteError("");
                  setShowDeleteWebsiteModal(true);
                }}
                disabled={!websiteId}
              >
                Delete Website
              </button>
              <button
                className="danger-btn"
                onClick={() => {
                  setDeleteAccountError("");
                  setShowDeleteAccountModal(true);
                }}
              >
                Delete All Data
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modals */}
      <ConfirmModal
        isOpen={showDeleteWebsiteModal}
        title="Delete Website"
        message={`Are you sure you want to delete ${targetSiteToDelete?.hostname || activeSite || "this website"} and all its data?`}
        description="This will permanently remove all crawled pages, audit logs, and monitoring history for this website. This action cannot be undone."
        confirmText="Confirm Delete"
        cancelText="Cancel"
        variant="danger"
        loading={isDeletingWebsite}
        onConfirm={handleConfirmDeleteWebsite}
        onCancel={() => setShowDeleteWebsiteModal(false)}
      />

      <ConfirmModal
        isOpen={showDeleteAccountModal}
        title="Delete All Data & Account"
        message="Are you sure you want to delete your account and all data?"
        description="This will permanently delete your user account, all connected websites, audit logs, and integrations. You will be logged out immediately. This action cannot be undone."
        confirmText="Confirm Delete All Data"
        cancelText="Cancel"
        variant="danger"
        loading={isDeletingAccount}
        onConfirm={handleConfirmDeleteAccount}
        onCancel={() => setShowDeleteAccountModal(false)}
      />
    </div>
  );
}
