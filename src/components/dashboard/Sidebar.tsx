import React from "react";
import { Logo } from "../Logo";

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
};

export interface SidebarProps {
  activeTab: string;
  onSelectTab: (tab: string) => void;
  websites: { hostname: string; displayName?: string }[];
  activeSite: string;
  onSelectSite: (site: string) => void;
  onAddSite: () => void;
  onLogout?: () => void;
  user?: { name?: string; email: string };
  onBackToLanding?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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
  collapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  return (
    <aside className={`dashboard-sidebar ${collapsed ? "is-collapsed" : ""}`}>
      {/* Brand Header with Collapse Toggle */}
      <div className="sidebar-brand-wrapper flex-between">
        <Logo dark iconOnly={collapsed} />
        <button
          className="collapse-toggle-btn"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? (
              <polyline points="9 18 15 12 9 6" />
            ) : (
              <polyline points="15 18 9 12 15 6" />
            )}
          </svg>
        </button>
      </div>

      {/* User Info Bar in Sidebar */}
      {user && !collapsed && (
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
          onClick={() => onSelectTab("overview")}
          title={collapsed ? "Overview" : undefined}
        >
          <span className="icon"><Icons.Overview /></span>
          {!collapsed && <span>Overview</span>}
        </a>

        {/* SEO Group */}
        <div className="nav-group">
          {!collapsed && <small className="nav-group-title">SEO</small>}
          <a
            className={`nav-item ${activeTab === "seo_audit" ? "active" : ""}`}
            onClick={() => onSelectTab("seo_audit")}
            title={collapsed ? "Audit & Health" : undefined}
          >
            <span className="icon"><Icons.Audit /></span>
            {!collapsed && <span>Audit &amp; Health</span>}
          </a>
          <a
            className={`nav-item ${activeTab === "pages" ? "active" : ""}`}
            onClick={() => onSelectTab("pages")}
            title={collapsed ? "Pages" : undefined}
          >
            <span className="icon"><Icons.Pages /></span>
            {!collapsed && <span>Pages</span>}
          </a>
          <a
            className={`nav-item ${activeTab === "search_performance" ? "active" : ""}`}
            onClick={() => onSelectTab("search_performance")}
            title={collapsed ? "Search Performance" : undefined}
          >
            <span className="icon"><Icons.Search /></span>
            {!collapsed && <span>Search Performance</span>}
          </a>
          <a
            className={`nav-item ${activeTab === "issues" ? "active" : ""}`}
            onClick={() => onSelectTab("issues")}
            title={collapsed ? "Issues" : undefined}
          >
            <span className="icon"><Icons.Issues /></span>
            {!collapsed && <span>Issues</span>}
          </a>
        </div>

        {/* Analytics Group */}
        <div className="nav-group">
          {!collapsed && <small className="nav-group-title">ANALYTICS</small>}
          <a
            className={`nav-item ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => onSelectTab("analytics")}
            title={collapsed ? "Analytics" : undefined}
          >
            <span className="icon"><Icons.Analytics /></span>
            {!collapsed && <span>Analytics</span>}
          </a>
        </div>

        {/* Monitoring Group */}
        <div className="nav-group">
          {!collapsed && <small className="nav-group-title">MONITORING</small>}
          <a
            className={`nav-item ${activeTab === "alerts" ? "active" : ""}`}
            onClick={() => onSelectTab("alerts")}
            title={collapsed ? "Alerts & Monitoring" : undefined}
          >
            <span className="icon"><Icons.Alerts /></span>
            {!collapsed && <span>Alerts &amp; Monitoring</span>}
          </a>
        </div>

        {/* Your Websites Group */}
        <div className="nav-group">
          {!collapsed && <small className="nav-group-title">YOUR WEBSITES</small>}
          {websites.map((site) => (
            <a
              key={site.hostname}
              className={`nav-item site-item ${activeSite === site.hostname ? "active" : ""}`}
              onClick={() => onSelectSite(site.hostname)}
              title={collapsed ? site.hostname : undefined}
            >
              <span className="icon"><Icons.Globe /></span>
              {!collapsed && <span className="site-name">{site.hostname}</span>}
            </a>
          ))}
          {!collapsed && (
            <button className="add-site-btn" onClick={onAddSite}>
              + Add Website
            </button>
          )}
        </div>

        {/* Integrations Group */}
        <div className="nav-group">
          {!collapsed && <small className="nav-group-title">INTEGRATIONS</small>}
          <a
            className={`nav-item ${activeTab === "gsc" ? "active" : ""}`}
            onClick={() => onSelectTab("gsc")}
            title={collapsed ? "Google Search Console" : undefined}
          >
            <span className="icon"><Icons.Integration /></span>
            {!collapsed && <span>Google Search Console</span>}
          </a>
          <a
            className={`nav-item ${activeTab === "ga" ? "active" : ""}`}
            onClick={() => onSelectTab("ga")}
            title={collapsed ? "Google Analytics" : undefined}
          >
            <span className="icon"><Icons.Integration /></span>
            {!collapsed && <span>Google Analytics</span>}
          </a>
        </div>

        {/* Settings, Landing Page & Logout at Bottom */}
        <div className="nav-footer">
          <a
            className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => onSelectTab("settings")}
            title={collapsed ? "Settings" : undefined}
          >
            <span className="icon"><Icons.Settings /></span>
            {!collapsed && <span>Settings</span>}
          </a>

          {onBackToLanding && (
            <a
              className="nav-item"
              onClick={onBackToLanding}
              title={collapsed ? "View Landing Page" : undefined}
            >
              <span className="icon"><Icons.Landing /></span>
              {!collapsed && <span>View Landing Page</span>}
            </a>
          )}

          {onLogout && (
            <a
              className="nav-item"
              onClick={onLogout}
              style={{ color: "#ef4444" }}
              title={collapsed ? "Log out" : undefined}
            >
              <span className="icon"><Icons.Logout /></span>
              {!collapsed && <span>Log out</span>}
            </a>
          )}
        </div>
      </nav>
    </aside>
  );
}
