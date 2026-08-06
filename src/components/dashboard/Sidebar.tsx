import React, { useState } from "react";
import { Logo } from "../Logo";
import { ConfirmModal } from "../ConfirmModal";

// Crisp SVG Icons for Navigation Items
const Icons = {
  Overview: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  Audit: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  Pages: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  Search: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <polyline points="11 8 11 11 14 11" />
    </svg>
  ),
  Issues: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  Analytics: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  Alerts: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  Globe: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  Integration: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  Settings: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Landing: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  ),
  Logout: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  Trash: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  ),
};

export interface SidebarProps {
  activeTab: string;
  onSelectTab: (tab: string) => void;
  websites: { _id?: string; hostname: string; displayName?: string }[];
  activeSite: string;
  onSelectSite: (site: string) => void;
  onAddSite: () => void;
  onLogout?: () => void;
  user?: { name?: string; email: string };
  onBackToLanding?: () => void;
  onDeleteWebsite?: (site: { _id?: string; hostname: string }) => void;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  websites,
  activeSite,
  onSelectSite,
  onAddSite,
  onLogout,
  user,
  onBackToLanding,
  onDeleteWebsite,
  isOpenMobile,
  onCloseMobile,
}: SidebarProps) {
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState<{ _id?: string; hostname: string } | null>(null);
  const [isDeletingWebsite, setIsDeletingWebsite] = useState(false);

  const handleTabClick = (tab: string) => {
    onSelectTab(tab);
    if (onCloseMobile) onCloseMobile();
  };

  const handleSiteClick = (site: string) => {
    onSelectSite(site);
    if (onCloseMobile) onCloseMobile();
  };

  return (
    <>
      {isOpenMobile && <div className="sidebar-backdrop-mobile" onClick={onCloseMobile} />}
      <aside className={`dashboard-sidebar ${isOpenMobile ? "mobile-open" : ""}`}>
      {/* Brand Header */}
      <div className="sidebar-brand-wrapper">
        <div className="sidebar-logo-icon"><Logo dark iconOnly /></div>
        <div className="sidebar-logo-full"><Logo dark /></div>
      </div>

      {/* User Info Bar */}
      {user && (
        <div className="sidebar-user-pill">
          <span className="user-avatar-small">
            {user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}
          </span>
          <span className="user-name-text">{user.name || user.email}</span>
        </div>
      )}

      {/* Main Navigation */}
      <nav className="sidebar-nav">
        {/* Overview */}
        <a
          className={`nav-item ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => handleTabClick("overview")}
          title="Overview"
        >
          <span className="icon"><Icons.Overview /></span>
          <span className="nav-label">Overview</span>
        </a>

        {/* SEO Group */}
        <div className="nav-group">
          <small className="nav-group-title">SEO</small>
          <a
            className={`nav-item ${activeTab === "seo_audit" ? "active" : ""}`}
            onClick={() => handleTabClick("seo_audit")}
            title="Audit &amp; Health"
          >
            <span className="icon"><Icons.Audit /></span>
            <span className="nav-label">Audit &amp; Health</span>
          </a>
          <a
            className={`nav-item ${activeTab === "pages" ? "active" : ""}`}
            onClick={() => handleTabClick("pages")}
            title="Pages"
          >
            <span className="icon"><Icons.Pages /></span>
            <span className="nav-label">Pages</span>
          </a>
          <a
            className={`nav-item ${activeTab === "issues" ? "active" : ""}`}
            onClick={() => handleTabClick("issues")}
            title="Issues"
          >
            <span className="icon"><Icons.Issues /></span>
            <span className="nav-label">Issues</span>
          </a>
        </div>

        {/* Analytics Group */}
        <div className="nav-group">
          <small className="nav-group-title">ANALYTICS</small>
          <a
            className={`nav-item ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => handleTabClick("analytics")}
            title="Analytics"
          >
            <span className="icon"><Icons.Analytics /></span>
            <span className="nav-label">Analytics</span>
          </a>
        </div>

        {/* Your Websites Group */}
        <div className="nav-group">
          <small className="nav-group-title">YOUR WEBSITES</small>
          {websites.map((site) => (
            <div
              key={site.hostname}
              className={`nav-item site-item ${activeSite === site.hostname ? "active" : ""}`}
              onClick={() => handleSiteClick(site.hostname)}
              title={site.hostname}
              style={{ position: "relative" }}
            >
              <span className="icon"><Icons.Globe /></span>
              <span className="nav-label site-name">{site.hostname}</span>
              <button
                className="delete-site-btn nav-label"
                title={`Delete ${site.hostname}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSiteToDelete(site);
                }}
              >
                <Icons.Trash />
              </button>
            </div>
          ))}
          <button className="add-site-btn" onClick={() => { onAddSite(); if (onCloseMobile) onCloseMobile(); }} title="Add Website">
            <span className="add-site-icon">+</span>
            <span className="nav-label">Add Website</span>
          </button>
        </div>

        {/* Integrations Group */}
        <div className="nav-group">
          <small className="nav-group-title">INTEGRATIONS</small>
          <a
            className={`nav-item ${activeTab === "gsc" ? "active" : ""}`}
            onClick={() => handleTabClick("gsc")}
            title="Google Search Console"
          >
            <span className="icon"><Icons.Integration /></span>
            <span className="nav-label">Google Search Console</span>
          </a>
          <a
            className={`nav-item ${activeTab === "ga" ? "active" : ""}`}
            onClick={() => handleTabClick("ga")}
            title="Google Analytics 4"
          >
            <span className="icon"><Icons.Integration /></span>
            <span className="nav-label">Google Analytics 4</span>
          </a>
        </div>

        {/* Settings */}
        <div className="nav-group">
          <small className="nav-group-title">ACCOUNT</small>
          <a
            className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => handleTabClick("settings")}
            title="Settings"
          >
            <span className="icon"><Icons.Settings /></span>
            <span className="nav-label">Settings</span>
          </a>
        </div>

        <div className="nav-footer">
          {onBackToLanding && (
            <a
              className="nav-item"
              onClick={onBackToLanding}
              title="View Landing Page"
            >
              <span className="icon"><Icons.Landing /></span>
              <span className="nav-label">View Landing Page</span>
            </a>
          )}

          {onLogout && (
            <a
              className="nav-item"
              onClick={() => setShowLogoutModal(true)}
              style={{ color: "#ef4444" }}
              title="Log out"
            >
              <span className="icon"><Icons.Logout /></span>
              <span className="nav-label">Log out</span>
            </a>
          )}
        </div>
      </nav>

      <ConfirmModal
        isOpen={showLogoutModal}
        title="Log Out"
        message="Are you sure you want to log out?"
        description="You will need to sign in again to access your dashboard and website reports."
        confirmText="Log Out"
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowLogoutModal(false);
          if (onLogout) onLogout();
        }}
        onCancel={() => setShowLogoutModal(false)}
      />

      <ConfirmModal
        isOpen={Boolean(siteToDelete)}
        title="Delete Website"
        message={`Are you sure you want to delete ${siteToDelete?.hostname || "this website"}?`}
        description="All associated crawl history, audit reports, and tracking data for this website will be permanently removed. This action cannot be undone."
        confirmText="Delete Website"
        cancelText="Cancel"
        variant="danger"
        isLoading={isDeletingWebsite}
        onConfirm={async () => {
          if (!siteToDelete) return;
          setIsDeletingWebsite(true);
          try {
            if (siteToDelete._id) {
              await fetch(`/api/v1/websites/${siteToDelete._id}`, { method: "DELETE" });
            }
            if (onDeleteWebsite) {
              onDeleteWebsite(siteToDelete);
            }
          } catch (err) {
            console.error("Failed to delete website:", err);
          } finally {
            setIsDeletingWebsite(false);
            setSiteToDelete(null);
          }
        }}
        onCancel={() => setSiteToDelete(null)}
      />
    </aside>
    </>
  );
}
