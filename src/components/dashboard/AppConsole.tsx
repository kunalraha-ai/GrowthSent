import React, { useState, useEffect, useRef } from "react";
import { Sidebar } from "./Sidebar";
import { Logo } from "../Logo";
import { OverviewView } from "./OverviewView";
import { SeoAuditView } from "./SeoAuditView";
import { PagesView } from "./PagesView";
import { SearchPerformanceView } from "./SearchPerformanceView";
import { IssuesView } from "./IssuesView";
import { AnalyticsView } from "./AnalyticsView";
import { SettingsView } from "./SettingsView";
import BacklinkAnalyticsView from "./BacklinkAnalyticsView";
import AiReadinessView from "./AiReadinessView";
import { toAuditJobUiStatus, toAuditProgress, type AuditJobUiStatus, type AuditProgress } from "./audit-status";

export interface UserProfile {
  id?: string;
  email: string;
  name?: string;
  role?: string;
}

export interface WebsiteItem {
  _id?: string;
  hostname: string;
  displayName?: string;
}

interface AuditFailure {
  message: string;
  code?: string;
  retryUrl?: string;
}

const EMPTY_AUDIT_PROGRESS: AuditProgress = { status: null, progressPercent: 0, pagesCrawled: 0 };

interface AppConsoleProps {
  user: UserProfile;
  onLogout: () => void;
  onBackToLanding: () => void;
  initialTab?: string;
}

function AddWebsiteModal({ onClose, onAdded }: { onClose: () => void; onAdded: (site: WebsiteItem, jobId?: string) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError("");

    try {
      // Step 1: Create Website entry
      const res = await fetch("/api/v1/websites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error?.message || "Failed to add website.");
        setLoading(false);
        return;
      }

      // Step 2: Trigger async crawler engine job
      let jobId: string | undefined;
      try {
        const auditRes = await fetch("/api/v1/audit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: url.trim(), websiteId: data._id }),
        });
        const auditData = await auditRes.json();
        jobId = auditData.jobId;
      } catch (err) {
        console.error("Failed to start audit job:", err);
      }

      onAdded(data, jobId);
    } catch {
      setError("Failed to connect to API.");
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="add-site-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#ffffff",
          color: "#171817",
          width: "100%",
          maxWidth: "440px",
          borderRadius: "16px",
          border: "1px solid #dcddd6",
          padding: "24px",
          boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontFamily: "'Google Sans', sans-serif", fontSize: "18px", fontWeight: 800, color: "#171817" }}>
            Add Website to Audit
          </h3>
          <button onClick={onClose} className="close-btn" style={{ fontSize: "20px", color: "#171817", cursor: "pointer" }}>✕</button>
        </div>

        {error && <p style={{ color: "#ef4444", fontSize: "13px", margin: "0 0 12px 0", fontWeight: 600 }}>{error}</p>}

        <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label className="form-label" style={{ color: "#64655f", fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>
              Website Domain or URL
            </label>
            <input
              type="text"
              required
              placeholder="https://mynewsaas.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="form-input"
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid #dcddd6",
                fontSize: "14px",
                color: "#171817",
                background: "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="primary-btn"
            style={{
              width: "100%",
              padding: "12px",
              fontSize: "14px",
              fontWeight: 800,
              borderRadius: "8px",
              marginTop: "4px",
              cursor: "pointer",
            }}
          >
            {loading ? "Adding..." : "+ Add Website & Audit"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function AppConsole({
  user,
  onLogout,
  onBackToLanding,
  initialTab = "overview",
}: AppConsoleProps) {
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [websites, setWebsites] = useState<WebsiteItem[]>([]);
  const [activeSite, setActiveSite] = useState<string>("");
  const [activeWebsiteId, setActiveWebsiteId] = useState<string | null>(null);
  const [showAddSite, setShowAddSite] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [auditProgress, setAuditProgress] = useState<AuditProgress>(EMPTY_AUDIT_PROGRESS);
  const [scanResult, setScanResult] = useState<any>(null);
  const [isGscConnected, setIsGscConnected] = useState(false);
  const [isGaConnected, setIsGaConnected] = useState(false);
  const auditPollTimerRef = useRef<number | null>(null);
  const auditPollInFlightRef = useRef(false);

  const [auditFailure, setAuditFailure] = useState<AuditFailure | null>(null);

  const stopAuditPolling = () => {
    if (auditPollTimerRef.current !== null) {
      window.clearInterval(auditPollTimerRef.current);
      auditPollTimerRef.current = null;
    }
    auditPollInFlightRef.current = false;
  };

  useEffect(() => () => stopAuditPolling(), []);

  useEffect(() => {
    async function loadWebsites() {
      try {
        const res = await fetch("/api/v1/websites");
        const data = await res.json();
        if (data.websites && data.websites.length > 0) {
          setWebsites(data.websites);
          setActiveSite(data.websites[0].hostname);
          setActiveWebsiteId(data.websites[0]._id || null);
        }
      } catch (err) {
        console.error("Failed to load user websites:", err);
      }
    }
    loadWebsites();
  }, []);

  useEffect(() => {
    if (!activeWebsiteId) {
      setScanResult(null);
      setIsGscConnected(false);
      setIsGaConnected(false);
      return;
    }

    async function loadWebsiteData() {
      try {
        const [scanResponse, gscResponse, gaResponse] = await Promise.all([
          fetch(`/api/v1/websites/${activeWebsiteId}/latest-scan`),
          fetch(`/api/v1/integrations?websiteId=${activeWebsiteId}&provider=google_search_console`),
          fetch(`/api/v1/integrations?websiteId=${activeWebsiteId}&provider=google_analytics`),
        ]);
        if (scanResponse.ok) setScanResult(await scanResponse.json());
        if (gscResponse.ok) setIsGscConnected(Boolean((await gscResponse.json()).isConnected));
        if (gaResponse.ok) setIsGaConnected(Boolean((await gaResponse.json()).isConnected));
      } catch (error) {
        console.error("Failed to load saved website data:", error);
      }
    }

    loadWebsiteData();
  }, [activeWebsiteId]);

  const selectWebsite = (hostname: string) => {
    const website = websites.find((site) => site.hostname === hostname);
    setActiveSite(hostname);
    setActiveWebsiteId(website?._id || null);
  };

  const pollAudit = (jobId: string, initialStatus: AuditJobUiStatus = "queued", retryUrl?: string) => {
    stopAuditPolling();
    setIsScanning(true);
    setAuditProgress({ status: initialStatus, progressPercent: 0, pagesCrawled: 0 });
    const pollOnce = async () => {
      if (auditPollInFlightRef.current) return;
      auditPollInFlightRef.current = true;
      try {
        const response = await fetch(`/api/v1/audit/${jobId}`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
          stopAuditPolling();
          setIsScanning(false);
          setAuditProgress(EMPTY_AUDIT_PROGRESS);
          setAuditFailure({ message: "We could not check this audit’s progress. Please try again.", retryUrl });
          return;
        }
        setAuditProgress(toAuditProgress(data));
        if (data.status === "completed" || data.status === "failed") {
          stopAuditPolling();
          setIsScanning(false);
          setAuditProgress(EMPTY_AUDIT_PROGRESS);
          if (data.status === "completed") setScanResult(data);
          else setAuditFailure({
            message: typeof data.error === "string" ? data.error : "The audit could not be completed.",
            code: typeof data.errorCode === "string" ? data.errorCode : undefined,
            retryUrl,
          });
        }
      } catch {
        stopAuditPolling();
        setIsScanning(false);
        setAuditProgress(EMPTY_AUDIT_PROGRESS);
        setAuditFailure({ message: "We lost the connection while checking this audit. Please try again.", retryUrl });
      } finally {
        auditPollInFlightRef.current = false;
      }
    };
    void pollOnce();
    auditPollTimerRef.current = window.setInterval(() => void pollOnce(), 1500);
  };

  const handleScanForUrl = async (targetUrl: string) => {
    stopAuditPolling();
    setIsScanning(true);
    setAuditProgress({ status: "queued", progressPercent: 0, pagesCrawled: 0 });
    setAuditFailure(null);
    setScanResult(null);

    let cleanHost = targetUrl.trim().toLowerCase();
    try {
      if (!cleanHost.includes("://")) cleanHost = "https://" + cleanHost;
      cleanHost = new URL(cleanHost).hostname;
    } catch {
      cleanHost = targetUrl.trim().toLowerCase();
    }

    try {
      let website = websites.find((site) => site.hostname === cleanHost);
      if (!website?._id) {
        const websiteResponse = await fetch("/api/v1/websites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });
        const websiteData = await websiteResponse.json();
        if (!websiteResponse.ok || websiteData.error || !websiteData._id) {
          throw new Error(websiteData.error?.message || "Unable to add this website.");
        }
        website = websiteData;
        setWebsites((current) => current.some((site) => site._id === websiteData._id) ? current : [...current, websiteData]);
      }
      if (!website) throw new Error("Website creation failed.");

      setActiveSite(website.hostname);
      setActiveWebsiteId(website._id || null);

      const res = await fetch("/api/v1/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl.includes("://") ? targetUrl : `https://${cleanHost}`, websiteId: website._id }),
      });
      const data = await res.json();
      if (!res.ok || !data.jobId) throw new Error(data.error?.message || "Unable to start the audit.");
      pollAudit(data.jobId, toAuditJobUiStatus(data.status) || "queued", targetUrl);
    } catch (error) {
      setIsScanning(false);
      setAuditProgress(EMPTY_AUDIT_PROGRESS);
      setAuditFailure({ message: error instanceof Error ? error.message : "Unable to start the audit.", retryUrl: targetUrl });
    }
  };

  const handleFreshScan = async () => {
    if (activeSite) await handleScanForUrl(`https://${activeSite}`);
  };

  const retryAudit = () => {
    const retryUrl = auditFailure?.retryUrl || (activeSite ? `https://${activeSite}` : "");
    if (retryUrl) void handleScanForUrl(retryUrl);
  };

  const createAuditShareLink = async (): Promise<string> => {
    const scanId = scanResult?.scan?._id;
    if (typeof scanId !== "string" || !/^[a-f0-9]{24}$/i.test(scanId)) {
      throw new Error("This completed audit is not ready to share yet. Refresh and try again.");
    }
    const response = await fetch(`/api/v1/scans/${scanId}/share`, { method: "POST" });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(data.token)) {
      throw new Error(data?.error?.message || "We could not create a share link. Please try again.");
    }
    return new URL(`/audit/${data.token}`, window.location.origin).toString();
  };

  const handleWebsiteDeleted = (deletedId: string) => {
    setWebsites((prev) => {
      const updated = prev.filter((w) => w._id !== deletedId);
      if (updated.length > 0) {
        setActiveSite(updated[0].hostname);
        setActiveWebsiteId(updated[0]._id || null);
      } else {
        setActiveSite("");
        setActiveWebsiteId(null);
      }
      return updated;
    });
    setActiveTab("overview");
  };

  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  return (
    <div className="full-app-console">
      {/* Mobile Top Header Bar */}
      <div className="mobile-console-header">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            className="mobile-hamburger-btn"
            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
            aria-label="Toggle navigation menu"
          >
            {isMobileSidebarOpen ? "✕" : "☰"}
          </button>
          <Logo dark />
        </div>
        {activeSite && (
          <span className="mobile-active-site-pill">{activeSite}</span>
        )}
      </div>

      {/* Main Layout */}
      <div className="full-app-layout">
        {/* Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          websites={websites}
          activeSite={activeSite}
          onSelectSite={selectWebsite}
          onAddSite={() => setShowAddSite(true)}
          onLogout={onLogout}
          user={user}
          onBackToLanding={onBackToLanding}
          onDeleteWebsite={(site) => handleWebsiteDeleted(site._id || site.hostname)}
          isOpenMobile={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        {/* Console Main Content */}
        <div className="console-main">
          {auditFailure && (
            <div role="alert" style={{ marginBottom: "16px", padding: "14px", borderRadius: "8px", color: "#8a1c12", background: "#fef3f2", border: "1px solid #fecdca", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <div>
                <strong>Audit didn’t finish</strong>
                <div style={{ marginTop: "4px" }}>{auditFailure.message}</div>
                {auditFailure.code && <div style={{ marginTop: "4px", fontSize: "12px", color: "#9a4e47" }}>Reason: {auditFailure.code.replace(/_/g, " ").toLowerCase()}</div>}
              </div>
              <button className="secondary-btn" type="button" onClick={retryAudit} disabled={isScanning || !auditFailure.retryUrl && !activeSite}>Try again</button>
            </div>
          )}
          {activeTab === "overview" && (
            <OverviewView
              activeSite={activeSite}
              websites={websites}
              onSelectSite={selectWebsite}
              onNavigateTab={setActiveTab}
              onRunScan={handleFreshScan}
              onScanUrl={handleScanForUrl}
              isScanning={isScanning}
              auditProgress={auditProgress}
              isGscConnected={isGscConnected}
              scanResult={scanResult}
            />
          )}

          {activeTab === "seo_audit" && (
            <SeoAuditView
              activeSite={activeSite}
              onNavigateTab={setActiveTab}
              onRunScan={handleFreshScan}
              isScanning={isScanning}
              auditProgress={auditProgress}
              scanResult={scanResult}
              onCreateShareLink={createAuditShareLink}
            />
          )}

          {activeTab === "pages" && (
            <PagesView
              activeSite={activeSite}
              isScanning={isScanning}
              scanResult={scanResult}
            />
          )}

          {activeTab === "issues" && (
            <IssuesView
              activeSite={activeSite}
              onNavigateTab={setActiveTab}
              isScanning={isScanning}
              scanResult={scanResult}
            />
          )}

          {activeTab === "backlinks" && <BacklinkAnalyticsView initialDomain={activeSite} />}

          {activeTab === "ai_readiness" && <AiReadinessView activeSite={activeSite} websiteId={activeWebsiteId} />}

          {activeTab === "gsc" && (
            <SearchPerformanceView
              isGscConnected={isGscConnected}
              websiteId={activeWebsiteId}
            />
          )}

          {activeTab === "ga" && (
            <AnalyticsView
              activeSite={activeSite}
              websiteId={activeWebsiteId}
              onNavigateTab={setActiveTab}
            />
          )}

          {activeTab === "settings" && (
            <SettingsView
              activeSite={activeSite}
              websiteId={activeWebsiteId}
              websites={websites}
              onSelectWebsite={(site) => {
                setActiveSite(site.hostname);
                setActiveWebsiteId(site._id || null);
              }}
              onAddSite={() => setShowAddSite(true)}
              isGscConnected={isGscConnected}
              isGaConnected={isGaConnected}
              onWebsiteDeleted={handleWebsiteDeleted}
              onAccountDeleted={onLogout}
            />
          )}
        </div>
      </div>

      {/* Add Website Modal */}
      {showAddSite && (
        <AddWebsiteModal
          onClose={() => setShowAddSite(false)}
          onAdded={(newSite, jobId) => {
            setWebsites((current) => current.some((site) => site._id === newSite._id) ? current : [...current, newSite]);
            setActiveSite(newSite.hostname);
            setActiveWebsiteId(newSite._id || null);
            setShowAddSite(false);

            if (jobId) {
              pollAudit(jobId, "queued", `https://${newSite.hostname}`);
            }
          }}
        />
      )}
    </div>
  );
}
