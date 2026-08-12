import { useState, useEffect, useRef, type ReactNode } from "react";
import { AppConsole } from "./components/dashboard/AppConsole";
import { PrivacyPolicy } from "./components/PrivacyPolicy";
import { TermsOfService } from "./components/TermsOfService";
import { PricingPage } from "./components/PricingPage";
import { NotFound404 } from "./components/NotFound404";
import { ServerError500 } from "./components/ServerError500";
import { Logo } from "./components/Logo";

const Check = ({ children }: { children: ReactNode }) => <div className="check"><span>✓</span>{children}</div>;
const Warn = ({ children }: { children: ReactNode }) => <div className="warn"><span>!</span>{children}</div>;

const ClaudeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
    <path
      clipRule="evenodd"
      d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      fill="#D97757"
      fillRule="evenodd"
    />
  </svg>
);

const CursorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" style={{ flexShrink: 0 }}>
    <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
  </svg>
);

const CodexIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
    <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff" />
    <path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#lobe-icons-codex-gradient)" />
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-gradient" x1="12" x2="12" y1="3" y2="21">
        <stop stopColor="#B1A7FF" />
        <stop offset=".5" stopColor="#7A9DFF" />
        <stop offset="1" stopColor="#3941FF" />
      </linearGradient>
    </defs>
  </svg>
);

const GscIcon = () => (
  <svg width="18" height="18" viewBox="0 0 40 40" style={{ flexShrink: 0 }}>
    <g clipPath="url(#gsc-clip-map)">
      <path fill="#fbbc04" d="m11.081 30.527-4.72 4.721a.933.933 0 0 1-1.317 0l-.292-.292a.933.933 0 0 1 0-1.316l4.72-4.721a.933.933 0 0 1 1.318 0l.291.291a.93.93 0 0 1 0 1.317"/>
      <path fill="#4285f4" d="M23.75 32.5h6.042a6.04 6.04 0 0 0 6.041-6.042v-16.25a6.04 6.04 0 0 0-6.041-6.041 6.04 6.04 0 0 0-6.042 6.041z"/>
      <path fill="#fbbc04" d="M13.75 32.5a6.04 6.04 0 0 0 6.042-6.042 6.04 6.04 0 0 0-6.042-6.041 6.04 6.04 0 0 0-6.042 6.041A6.04 6.04 0 0 0 13.75 32.5"/>
      <path fill="#34a853" d="M27.97 32.5h-5.887a6.04 6.04 0 0 1-6.041-6.042v-7.916a6.04 6.04 0 0 1 6.041-6.042 6.04 6.04 0 0 1 6.042 6.042v13.804a.154.154 0 0 1-.154.154z"/>
      <path fill="#1967d2" d="M28.125 32.346V18.542a6.04 6.04 0 0 0-4.375-5.807V32.5h4.22a.154.154 0 0 0 .155-.154"/>
      <path fill="#ea4335" d="M19.792 26.575a6.04 6.04 0 0 0-3.75-5.59v5.59c0 1.72.72 3.273 1.875 4.373a6.02 6.02 0 0 0 1.875-4.373"/>
    </g>
    <defs>
      <clipPath id="gsc-clip-map">
        <path fill="#fff" d="M0 0h40v40H0z"/>
      </clipPath>
    </defs>
  </svg>
);

const GaIcon = () => (
  <svg width="18" height="18" viewBox="0 0 2195.9 2430.9" style={{ flexShrink: 0 }}>
    <g>
      <path fill="#F9AB00" d="M2195.9,2126.7c0.9,166.9-133.7,302.8-300.5,303.7c-12.4,0.1-24.9-0.6-37.2-2.1c-154.8-22.9-268.2-157.6-264.4-314V316.1c-3.7-156.6,110-291.3,264.9-314c165.7-19.4,315.8,99.2,335.2,264.9c1.4,12.2,2.1,24.4,2,36.7L2195.9,2126.7z"/>
      <path fill="#E37400" d="M301.1,1828.7c166.3,0,301.1,134.8,301.1,301.1c0,166.3-134.8,301.1-301.1,301.1C134.8,2430.9,0,2296.1,0,2129.8C0,1963.5,134.8,1828.7,301.1,1828.7z M1093.3,916.2c-167.1,9.2-296.7,149.3-292.8,316.6v808.7c0,219.5,96.6,352.7,238.1,381.1c163.3,33.1,322.4-72.4,355.5-235.7c4.1-20,6.1-40.3,6-60.7v-907.4c0.3-166.9-134.7-302.4-301.6-302.7C1096.8,916.1,1095,916.1,1093.3,916.2z"/>
    </g>
  </svg>
);

export interface LiveScanResult {
  scanId: string;
  url: string;
  hostname: string;
  status: string;
  seoScore?: number;
  totalPagesCrawled?: number;
  crawlStats?: {
    totalPagesCrawled: number;
    totalDurationMs: number;
    bytesDownloaded: number;
    statusCodesCount: Record<string, number>;
  };
  summaryMetrics?: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    criticalIssues: number;
    highIssues: number;
    mediumIssues: number;
    lowIssues: number;
    infoIssues: number;
  };
  error?: string;
}

export interface PageItem {
  url: string;
  statusCode: number;
  responseTimeMs: number;
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  isNoindex: boolean;
  headings: { h1: string[] };
}

export interface IssueItem {
  ruleId: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  explanation: string;
  affectedUrl: string;
  recommendation: string;
}

export interface UserProfile {
  id?: string;
  email: string;
  name?: string;
  role?: string;
}

export interface WebsiteItem {
  _id?: string;
  hostname: string;
  displayName: string;
  monitoringEnabled?: boolean;
}

// ---------------------------------------------------------
// ACCOUNT AUTHENTICATION
// ---------------------------------------------------------
function AuthModal({
  onClose,
  onAuthenticated,
  initialError,
}: {
  onClose: () => void;
  onAuthenticated: (user: UserProfile) => void;
  initialError?: string;
}) {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(initialError || "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg("Email and password are required.");
      return;
    }
    setLoading(true);
    setErrorMsg("");

    const endpoint = isSignup ? "/api/v1/auth/signup" : "/api/v1/auth/login";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSignup ? { email, password, name } : { email, password }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        setErrorMsg(`Server error (${res.status}). Ensure MONGODB_URI and SESSION_SECRET environment variables are set in Vercel.`);
        setLoading(false);
        return;
      }

      if (!res.ok || data.error) {
        setErrorMsg(data.error?.message || "Authentication failed.");
        setLoading(false);
        return;
      }

      onAuthenticated(data.user || { email, name: name || email.split("@")[0] });
    } catch {
      setErrorMsg("Network error connecting to backend.");
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(10, 11, 10, 0.8)",
      backdropFilter: "blur(8px)",
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
    }}>
      <div style={{
        background: "#171817",
        color: "#f7f7f3",
        width: "100%",
        maxWidth: "420px",
        borderRadius: "16px",
        border: "1px solid #383a35",
        padding: "32px",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.6)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <Logo dark />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888982", fontSize: "20px", cursor: "pointer" }}>✕</button>
        </div>

        <h2 style={{ fontSize: "22px", fontWeight: 800, margin: "0 0 6px 0" }}>
          {isSignup ? "Create your GrowthSent account" : "Log in to GrowthSent"}
        </h2>
        <p style={{ fontSize: "13px", color: "#8c8d86", margin: "0 0 20px 0" }}>
          No credit card required. Manage your websites &amp; SEO health.
        </p>

        {/* Social OAuth Buttons (real Google / GitHub sign-in) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              setErrorMsg("");
              try {
                const res = await fetch("/api/v1/auth/google/start");
                const data = await res.json();
                if (!res.ok || !data.authorizationUrl) {
                  throw new Error(data.error?.message || "Unable to start Google sign-in.");
                }
                window.location.assign(data.authorizationUrl);
              } catch (err) {
                setErrorMsg(err instanceof Error ? err.message : "Unable to start Google sign-in.");
                setLoading(false);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              background: "#20211e",
              color: "#ffffff",
              border: "1px solid #383a35",
              padding: "11px",
              borderRadius: "8px",
              fontWeight: 700,
              fontSize: "13px",
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            Continue with Google
          </button>

          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              setErrorMsg("");
              try {
                const res = await fetch("/api/v1/auth/github/start");
                const data = await res.json();
                if (!res.ok || !data.authorizationUrl) {
                  throw new Error(data.error?.message || "Unable to start GitHub sign-in.");
                }
                window.location.assign(data.authorizationUrl);
              } catch (err) {
                setErrorMsg(err instanceof Error ? err.message : "Unable to start GitHub sign-in.");
                setLoading(false);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              background: "#20211e",
              color: "#ffffff",
              border: "1px solid #383a35",
              padding: "11px",
              borderRadius: "8px",
              fontWeight: 700,
              fontSize: "13px",
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            Continue with GitHub
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "16px 0", color: "#666" }}>
          <div style={{ flex: 1, height: "1px", background: "#383a35" }} />
          <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px", color: "#888" }}>or continue with email</span>
          <div style={{ flex: 1, height: "1px", background: "#383a35" }} />
        </div>

        {errorMsg && (
          <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", color: "#ef4444", padding: "10px 14px", borderRadius: "8px", fontSize: "12px", marginBottom: "16px" }}>
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {isSignup && (
            <div>
              <label style={{ fontSize: "12px", color: "#aaaaa2", display: "block", marginBottom: "4px" }}>Name</label>
              <input
                type="text"
                placeholder="Alex Developer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", background: "#20211e", border: "1px solid #383a35", color: "#ffffff", fontSize: "14px" }}
              />
            </div>
          )}

          <div>
            <label style={{ fontSize: "12px", color: "#aaaaa2", display: "block", marginBottom: "4px" }}>Email Address</label>
            <input
              type="email"
              required
              placeholder="alex@yourdomain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", background: "#20211e", border: "1px solid #383a35", color: "#ffffff", fontSize: "14px" }}
            />
          </div>

          <div>
            <label style={{ fontSize: "12px", color: "#aaaaa2", display: "block", marginBottom: "4px" }}>Password</label>
            <input
              type="password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", background: "#20211e", border: "1px solid #383a35", color: "#ffffff", fontSize: "14px" }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              background: "#a4ef51",
              color: "#171817",
              border: "none",
              padding: "12px",
              borderRadius: "8px",
              fontWeight: 800,
              fontSize: "14px",
              cursor: "pointer",
              marginTop: "8px",
            }}
          >
            {loading ? "Authenticating..." : isSignup ? "Create Account" : "Log In"}
          </button>
        </form>

        <p style={{ textAlign: "center", margin: 0, fontSize: "12px", color: "#8c8d86" }}>
          {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
          <a
            onClick={() => setIsSignup(!isSignup)}
            style={{ color: "#a4ef51", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}
          >
            {isSignup ? "Log in" : "Sign up"}
          </a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------
// ADD WEBSITE MODAL
// ---------------------------------------------------------
function AddWebsiteModal({ onClose, onAdded }: { onClose: () => void; onAdded: (site: WebsiteItem) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/v1/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error?.message || "Failed to add website.");
        setLoading(false);
        return;
      }

      onAdded(data);
    } catch {
      setError("Failed to connect to API.");
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(10, 11, 10, 0.8)",
      backdropFilter: "blur(8px)",
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
    }}>
      <div style={{
        background: "#171817",
        color: "#f7f7f3",
        width: "100%",
        maxWidth: "400px",
        borderRadius: "14px",
        border: "1px solid #383a35",
        padding: "28px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 800 }}>Add Website to Audit</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888982", fontSize: "20px", cursor: "pointer" }}>✕</button>
        </div>

        {error && <p style={{ color: "#ef4444", fontSize: "12px" }}>{error}</p>}

        <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "12px", color: "#aaaaa2", display: "block", marginBottom: "4px" }}>Website Domain or URL</label>
            <input
              type="text"
              required
              placeholder="https://mynewsaas.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", background: "#20211e", border: "1px solid #383a35", color: "#ffffff", fontSize: "14px" }}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            style={{ background: "#a4ef51", color: "#171817", border: "none", padding: "10px", borderRadius: "8px", fontWeight: 800, cursor: "pointer", marginTop: "6px" }}
          >
            {loading ? "Adding..." : "+ Add Website & Audit"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------
// URL BAR COMPONENT
// ---------------------------------------------------------
function UrlBar({ dark = false, onScanStarted, onScanResult }: { dark?: boolean; onScanStarted?: () => void; onScanResult?: (scan: LiveScanResult) => void }) {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const go = async () => {
    if (!url.trim()) return;
    stopPolling();
    setScanning(true);
    setErrorMessage("");
    if (onScanStarted) onScanStarted();

    try {
      const res = await fetch("/api/v1/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setErrorMessage(data.error?.message || "Failed to start the audit.");
        setScanning(false);
        return;
      }

      const jobId = data.jobId;
      if (!jobId) throw new Error("Audit job did not return an identifier.");

      // Use the same bounded audit path as the dashboard. Polling is cleaned
      // up on unmount and never starts a second legacy scan.
      pollTimerRef.current = window.setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/v1/audit/${jobId}`);
          const scanData = await pollRes.json().catch(() => null);
          if (!pollRes.ok || !scanData) {
            stopPolling();
            setScanning(false);
            setErrorMessage("Unable to check audit progress. Please try again later.");
            return;
          }

          if (scanData.status === "completed" || scanData.status === "failed") {
            stopPolling();
            setScanning(false);
            if (scanData.status === "completed" && scanData.scan && onScanResult) onScanResult(scanData.scan as LiveScanResult);
            if (scanData.status === "failed") setErrorMessage(scanData.error || "The audit could not be completed.");
          }
        } catch {
          stopPolling();
          setScanning(false);
          setErrorMessage("Lost connection while checking audit progress.");
        }
      }, 3000);
    } catch {
      setErrorMessage("Network error starting scan.");
      setScanning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div className={`url-bar ${dark ? "on-dark" : ""}`}>
        <span className="lock">⌁</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yourwebsite.com"
          aria-label="Website URL"
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <button onClick={go} className="scan-button" disabled={scanning}>
          {scanning ? <><b className="spinner" />Scanning...</> : <>Check my website &nbsp;→</>}
        </button>
      </div>
      {errorMessage && <small style={{ color: "#ef4444", fontSize: "12px" }}>{errorMessage}</small>}
    </div>
  );
}



function MiniChart() {
  return <div className="chart"><div className="chart-labels"><span>4.2k</span><span>2.8k</span><span>1.4k</span><span>0</span></div><svg viewBox="0 0 620 180" preserveAspectRatio="none" aria-label="Organic visitors chart"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#a4ff45" stopOpacity=".28"/><stop offset="1" stopColor="#a4ff45" stopOpacity="0"/></linearGradient></defs><path d="M0 156 C38 145 42 154 72 138 S118 120 140 130 S175 111 198 116 S231 97 251 108 S288 105 306 87 S339 90 363 70 S397 83 421 61 S462 67 484 39 S518 48 543 25 S580 27 620 4 L620 180 L0 180Z" fill="url(#chartFill)"/><path d="M0 156 C38 145 42 154 72 138 S118 120 140 130 S175 111 198 116 S231 97 251 108 S288 105 306 87 S339 90 363 70 S397 83 421 61 S462 67 484 39 S518 48 543 25 S580 27 620 4" fill="none" stroke="#83d62d" strokeWidth="3"/></svg><div className="chart-months"><span>May 1</span><span>May 8</span><span>May 15</span><span>May 22</span><span>May 29</span></div></div>;
}

// Mini preview window component for landing page
function ConsolePreview({ onSelectTab }: { onSelectTab?: (tab: string) => void }) {
  const [activeTab, setActiveTab] = useState<string>("overview");

  return (
    <div className="console">
      <aside>
        <Logo dark />
        <a className={activeTab === "overview" ? "active" : ""} onClick={() => { setActiveTab("overview"); onSelectTab?.("overview"); }}>
          <span>◫ Overview</span>
        </a>
        <small>SEO</small>
        <a className={activeTab === "seo" ? "active" : ""} onClick={() => { setActiveTab("seo"); onSelectTab?.("seo"); }}>
          <span>⌁ SEO Audit &amp; Health</span>
        </a>
        <a className={activeTab === "pages_tab" ? "active" : ""} onClick={() => { setActiveTab("pages_tab"); onSelectTab?.("pages_tab"); }}>
          <span>⌁ Pages</span>
        </a>
        <a className={activeTab === "keywords" ? "active" : ""} onClick={() => { setActiveTab("keywords"); onSelectTab?.("keywords"); }}>
          <span>⌕ Search Keywords</span>
        </a>
        <a className={activeTab === "issues" ? "active" : ""} onClick={() => { setActiveTab("issues"); onSelectTab?.("issues"); }}>
          <span>⊙ Issues</span> <b>7</b>
        </a>

        <small>ANALYTICS</small>
        <a className={activeTab === "analytics" ? "active" : ""} onClick={() => { setActiveTab("analytics"); onSelectTab?.("analytics"); }}>
          <span>⌁ Analytics</span>
        </a>

        <small>YOUR WEBSITES</small>
        <a className="active">
          <span>● example.com</span>
          <span style={{ fontSize: "10px", color: "#4f8c18" }}>Healthy</span>
        </a>
      </aside>

      <div className="console-main">
        {activeTab === "overview" && (
          <>
            <div className="console-title">
              <div>
                <p>OVERVIEW</p>
                <h3>example.com <span>● Healthy</span></h3>
              </div>
              <button>Last 30 days⌄</button>
            </div>
            <div className="metrics">
              <div>
                <p>Visitors</p>
                <b>3,421</b>
                <span>↗ 18.2% <em>this month</em></span>
              </div>
              <div>
                <p>Search impressions</p>
                <b>12,400</b>
                <span>↗ 24.8% <em>this month</em></span>
              </div>
              <div>
                <p>Pages discovered</p>
                <b>124</b>
                <span><em>updated today</em></span>
              </div>
              <div>
                <p>Search-ready</p>
                <b>116 <em>/ 124</em></b>
                <span>93.5% healthy</span>
              </div>
            </div>
            <div className="console-bottom">
              <div className="traffic">
                <div><b>Organic visitors</b><span>May 2025</span></div>
                <MiniChart />
              </div>
              <div className="issues">
                <div><b>Needs attention</b><span>7 issues</span></div>
                <p><i /> Indexing issues <em>3</em></p>
                <p><i /> Missing descriptions <em>8</em></p>
                <p><i /> Broken links <em>2</em></p>
                <a onClick={() => setActiveTab("issues")}>View all issues →</a>
              </div>
            </div>
          </>
        )}

        {activeTab === "seo" && (
          <>
            <div className="console-title">
              <div>
                <p>SEO AUDIT &amp; HEALTH</p>
                <h3>Technical SEO <span>● 93.5% Score</span></h3>
              </div>
              <button>Run fresh scan ↻</button>
            </div>
            <div className="metrics">
              <div>
                <p>Crawlability</p>
                <b>121 <em>/ 124</em></b>
                <span>97.5% crawled</span>
              </div>
              <div>
                <p>Sitemap Status</p>
                <b>Valid</b>
                <span><em>sitemap.xml active</em></span>
              </div>
              <div>
                <p>Meta Tags Valid</p>
                <b>113 <em>/ 124</em></b>
                <span>11 missing descriptions</span>
              </div>
              <div>
                <p>HTTPS Security</p>
                <b>100%</b>
                <span>SSL Valid</span>
              </div>
            </div>
            <div className="console-table-card">
              <div className="table-header"><b>SEO Health Check</b><span>124 pages analyzed</span></div>
              <div className="console-table">
                <div className="table-row"><span>Canonical URLs</span><p>All pages specify canonical tags correctly</p><span className="badge pass">Pass</span></div>
                <div className="table-row"><span>Robots.txt</span><p>Found at /robots.txt — 0 blocking errors</p><span className="badge pass">Pass</span></div>
                <div className="table-row"><span>Open Graph Meta</span><p>8 social share cards missing og:image</p><span className="badge warn">Warning</span></div>
                <div className="table-row"><span>Heading Hierarchy</span><p>3 pages have multiple H1 tags</p><span className="badge fix">Needs Fix</span></div>
              </div>
            </div>
          </>
        )}

        {activeTab === "pages_tab" && (
          <>
            <div className="console-title">
              <div>
                <p>DISCOVERED PAGES</p>
                <h3>Site Index <span>● 124 URLs Crawled</span></h3>
              </div>
              <button>Export CSV ⤓</button>
            </div>
            <div className="metrics">
              <div><p>Total Pages</p><b>124</b><span>100% indexed</span></div>
              <div><p>HTTP 200 OK</p><b>121</b><span>97.5% healthy</span></div>
              <div><p>Redirects</p><b>2</b><span>301 Permanent</span></div>
              <div><p>Errors</p><b>1</b><span>404 Not Found</span></div>
            </div>
            <div className="console-table-card">
              <div className="table-header"><b>Scanned Pages Index</b><span>124 URLs</span></div>
              <div className="console-table">
                <div className="table-row"><span>/ (Homepage)</span><p>200 OK · 180ms · Title: GrowthSent — Developer-First SEO</p><span className="badge pass">200 OK</span></div>
                <div className="table-row"><span>/pricing</span><p>200 OK · 140ms · Title: Simple Pricing for Solo Founders</p><span className="badge pass">200 OK</span></div>
                <div className="table-row"><span>/docs/api</span><p>200 OK · 210ms · Missing title tag</p><span className="badge warn">Missing Title</span></div>
                <div className="table-row"><span>/team-old</span><p>404 Not Found · 90ms · Broken link</p><span className="badge fix">404 Error</span></div>
              </div>
            </div>
          </>
        )}

        {activeTab === "analytics" && (
          <>
            <div className="console-title">
              <div>
                <p>WEBSITE ANALYTICS</p>
                <h3>Traffic &amp; Behavior <span>● Live</span></h3>
              </div>
              <button>Real-time view 🟢</button>
            </div>
            <div className="metrics">
              <div>
                <p>Total Pageviews</p>
                <b>18,420</b>
                <span>↗ 14.5% <em>this week</em></span>
              </div>
              <div>
                <p>Unique Visitors</p>
                <b>3,421</b>
                <span>↗ 18.2% <em>this month</em></span>
              </div>
              <div>
                <p>Avg Session Time</p>
                <b>2m 14s</b>
                <span>↗ 8s longer</span>
              </div>
              <div>
                <p>Bounce Rate</p>
                <b>34.2%</b>
                <span>↘ -2.4% improved</span>
              </div>
            </div>
            <div className="console-table-card">
              <div className="table-header"><b>Top Performing Pages</b><span>Last 30 Days</span></div>
              <div className="console-table">
                <div className="table-row"><span>/ (Homepage)</span><p>11,200 views · 2m 45s avg</p><b>60.8%</b></div>
                <div className="table-row"><span>/pricing</span><p>4,200 views · 1m 50s avg</p><b>22.8%</b></div>
                <div className="table-row"><span>/docs/quickstart</span><p>1,840 views · 3m 10s avg</p><b>10.0%</b></div>
                <div className="table-row"><span>/blog/ai-seo-guide</span><p>1,180 views · 4m 02s avg</p><b>6.4%</b></div>
              </div>
            </div>
          </>
        )}

        {activeTab === "keywords" && (
          <>
            <div className="console-title">
              <div>
                <p>SEARCH KEYWORDS</p>
                <h3>Google Search Performance <span>● Connected</span></h3>
              </div>
              <button>Sync Search Console ↻</button>
            </div>
            <div className="metrics">
              <div>
                <p>Tracked Keywords</p>
                <b>342</b>
                <span>↗ 24 new</span>
              </div>
              <div>
                <p>Top 10 Rankings</p>
                <b>28</b>
                <span>↗ 5 this week</span>
              </div>
              <div>
                <p>Avg Position</p>
                <b>14.2</b>
                <span>↗ +2.1 ranks</span>
              </div>
              <div>
                <p>Organic Clicks</p>
                <b>1,240</b>
                <span>10.0% CTR</span>
              </div>
            </div>
            <div className="console-table-card">
              <div className="table-header"><b>Top Search Queries</b><span>By Clicks</span></div>
              <div className="console-table">
                <div className="table-row"><span>"ai coding tools seo"</span><p>Pos #2 · 410 clicks · 14.2% CTR</p><span className="badge pass">Top 3</span></div>
                <div className="table-row"><span>"solo founder analytics"</span><p>Pos #4 · 280 clicks · 8.9% CTR</p><span className="badge pass">Top 5</span></div>
                <div className="table-row"><span>"simple website health check"</span><p>Pos #7 · 190 clicks · 6.1% CTR</p><span className="badge pass">Top 10</span></div>
                <div className="table-row"><span>"lightweight cursor seo tool"</span><p>Pos #12 · 95 clicks · 3.4% CTR</p><span className="badge warn">Page 2</span></div>
              </div>
            </div>
          </>
        )}

        {activeTab === "issues" && (
          <>
            <div className="console-title">
              <div>
                <p>ACTIONABLE ISSUES</p>
                <h3>Fix List <span>● 7 Items</span></h3>
              </div>
              <button>✦ AI Fix All</button>
            </div>
            <div className="metrics">
              <div>
                <p>Critical Blockers</p>
                <b>3</b>
                <span>High impact</span>
              </div>
              <div>
                <p>Warnings</p>
                <b>2</b>
                <span>Medium impact</span>
              </div>
              <div>
                <p>Optimizations</p>
                <b>2</b>
                <span>Low impact</span>
              </div>
              <div>
                <p>AI Magic Fixes</p>
                <b>5 Available</b>
                <span>1-click fixes</span>
              </div>
            </div>
            <div className="console-table-card">
              <div className="table-header"><b>Active Issues (7)</b><span>Priority Order</span></div>
              <div className="console-table">
                <div className="table-row"><span>noindex meta tag on /blog/launch</span><p>Blocks Google from indexing your new launch post</p><button className="mini-btn">✦ AI Fix</button></div>
                <div className="table-row"><span>Missing title tag on /docs/api</span><p>Search engines cannot label this documentation page</p><button className="mini-btn">✦ AI Fix</button></div>
                <div className="table-row"><span>Broken link: /about → /team-old</span><p>Internal link yields 404 error</p><button className="mini-btn">✦ AI Fix</button></div>
                <div className="table-row"><span>Missing meta description on /pricing</span><p>Decreases search snippet CTR</p><button className="mini-btn">✦ AI Fix</button></div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}



// ---------------------------------------------------------
// MAIN ROOT APP COMPONENT
// ---------------------------------------------------------
function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [showLandingView, setShowLandingView] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !(params.has("integration") || params.has("websiteId") || params.has("code"));
  });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [activeScan, setActiveScan] = useState<LiveScanResult | null>(null);
  const [consoleTab, setConsoleTab] = useState<string>("overview");
  const [authRedirectError, setAuthRedirectError] = useState("");

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateTo = (path: string) => {
    window.history.pushState({}, "", path);
    setCurrentPath(path);
  };

  const cleanPath = currentPath.toLowerCase().replace(/\/$/, "") || "/";
  const isPrivacy = cleanPath === "/privacy" || cleanPath === "/privacy-policy";
  const isTerms = cleanPath === "/terms" || cleanPath === "/terms-of-service" || cleanPath === "/terms-and-conditions";
  const isPricing = cleanPath === "/pricing";
  const is500 = cleanPath === "/500";
  const isHome = cleanPath === "/";
  const is404 = !isHome && !isPrivacy && !isTerms && !isPricing && !is500;

  useEffect(() => {
    if (isHome) {
      document.title = "GrowthSent — Simple SEO & Website Analytics for Developers";
    }
  }, [isHome]);

  // Restore the server-issued session when the page reloads.
  useEffect(() => {
    fetch("/api/v1/auth/me")
      .then(async (response) => {
        if (!response.ok) return null;
        try {
          return await response.json();
        } catch {
          return null;
        }
      })
      .then((data) => {
        if (data?.user) setUser(data.user);
      })
      .catch(() => undefined);

    // Surface a failed Google/GitHub OAuth redirect (?authError=...) then clean the URL.
    const params = new URLSearchParams(window.location.search);
    const err = params.get("authError");
    if (err) {
      setAuthRedirectError(err);
      setShowAuthModal(true);
      params.delete("authError");
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "") + window.location.hash;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Ignored
    }

    setUser(null);
    setShowLandingView(true);
    setConsoleTab("overview");
  };

  const handleOpenReport = () => {
    if (user) {
      setShowLandingView(false);
    } else {
      setShowAuthModal(true);
    }
  };

  if (isPrivacy) {
    return <PrivacyPolicy onBack={() => navigateTo("/")} />;
  }

  if (isTerms) {
    return <TermsOfService onBack={() => navigateTo("/")} />;
  }

  if (isPricing) {
    return (
      <PricingPage
        onBack={() => navigateTo("/")}
        onGetStarted={() => {
          if (user) {
            setShowLandingView(false);
            navigateTo("/");
          } else {
            setShowAuthModal(true);
          }
        }}
        onContactSales={() => {
          window.location.href = "mailto:sales@growthsent.com?subject=GrowthSent%20Enterprise%20Inquiry";
        }}
      />
    );
  }

  if (is500) {
    return <ServerError500 onBack={() => navigateTo("/")} onRetry={() => window.location.reload()} />;
  }

  if (is404) {
    return <NotFound404 onBack={() => navigateTo("/")} onScanUrl={() => navigateTo("/")} />;
  }

  // If user is authenticated and not explicitly viewing landing page preview
  if (user && !showLandingView) {
    return (
      <AppConsole
        user={user}
        onLogout={handleLogout}
        onBackToLanding={() => setShowLandingView(true)}
        initialTab={consoleTab}
      />
    );
  }

  // Otherwise, render landing page
  return (
    <main>
      {user && showLandingView && (
        <div style={{ background: "#171817", color: "#a4ef51", padding: "10px 20px", fontSize: "13px", fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #383a35" }}>
          <span>● Authenticated as {user.name || user.email}</span>
          <button
            onClick={() => setShowLandingView(false)}
            style={{ background: "#a4ef51", color: "#171817", border: "none", padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 800, cursor: "pointer" }}
          >
            ← Return to Console
          </button>
        </div>
      )}

      <header className="site-header">
        <Logo />
        <nav>
          <a href="#product">Product</a>
          <a href="#how">How it works</a>
          <a href="/pricing" onClick={(e) => { e.preventDefault(); navigateTo("/pricing"); }}>Pricing</a>
          <a href="#developers">Developers</a>
        </nav>
        <div className="nav-actions">
          {user ? (
            <a onClick={() => setShowLandingView(false)} style={{ cursor: "pointer", color: "#a4ef51", fontWeight: 700 }}>Console →</a>
          ) : (
            <>
              <a onClick={() => setShowAuthModal(true)} style={{ cursor: "pointer" }}>Log in</a>
              <a className="dark-pill" onClick={() => setShowAuthModal(true)} style={{ cursor: "pointer" }}>Get started <span>↗</span></a>
            </>
          )}
        </div>
      </header>

      <section className="hero" id="start">
        <div className="eyebrow">A calmer way to grow <span className="pulse" /></div>
        <h1>SEO shouldn’t<br />be this hard.</h1>
        <p className="hero-copy">Paste your website. See what’s holding it back. GrowthSent gives you a simple view of your website’s health, discoverability, and growth.</p>
        <UrlBar onScanResult={(res) => setActiveScan(res)} />
        <p className="reassurance">No login. No setup. No credit card required.</p>
        <div className="orbit orbit-one" /><div className="orbit orbit-two" />
      </section>

      <section className="scan-preview wrap" id="product">
        <div className="scan-line">
          <span>LIVE WEBSITE SCAN</span>
          <span className="scanning-dot" />{" "}
          {activeScan ? `Scanned ${activeScan.totalPagesCrawled || activeScan.crawlStats?.totalPagesCrawled || 0} pages` : "Run a live website scan"}
        </div>
        <div className="preview-top">
          <div>
            <div className="domain-dot">{activeScan ? activeScan.hostname[0] : "y"}</div>
            <div>
              <strong>{activeScan ? activeScan.hostname : "yourwebsite.com"}</strong>
              <span>{activeScan ? "Last scanned just now" : "Last scanned just now"}</span>
            </div>
          </div>
          <div className="ready-score">
            <span>Website Health</span>
            <strong>{activeScan && activeScan.seoScore !== undefined ? activeScan.seoScore : "—"}<span>{activeScan ? "%" : ""}</span></strong>
            <em>{activeScan ? "ready for search" : "waiting for a scan"}</em>
          </div>
        </div>
        <div className="health-bar"><i style={{ width: `${activeScan?.seoScore ?? 0}%` }} /></div>
        <div className="insight-grid">
          <div className="insight-good">
            <Check>Sitemap checked</Check>
            <Check>HTTPS verified</Check>
            <Check>{activeScan ? `${activeScan.totalPagesCrawled || activeScan.crawlStats?.totalPagesCrawled || 0} pages crawlable` : "Live crawl results appear here"}</Check>
          </div>
          <div className="insight-warnings">
            <Warn>{activeScan?.summaryMetrics ? `${activeScan.summaryMetrics.criticalIssues} critical indexing issues` : "No scan data yet"}</Warn>
            <Warn>{activeScan?.summaryMetrics ? `${activeScan.summaryMetrics.highIssues} high priority warnings` : "No scan data yet"}</Warn>
            <Warn>{activeScan?.summaryMetrics ? `${activeScan.summaryMetrics.mediumIssues} medium priority fixes` : "No scan data yet"}</Warn>
          </div>
        </div>
        <div className="preview-foot">
          <span>GrowthSent scans public website data, so there’s nothing to connect.</span>
          <button onClick={handleOpenReport} style={{ cursor: "pointer" }}>View full report <span>→</span></button>
        </div>
      </section>



      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          initialError={authRedirectError}
          onAuthenticated={(loggedInUser) => {
            setUser(loggedInUser);
            setShowAuthModal(false);
          }}
        />
      )}

      <section className="narrow editorial">
        <p className="section-kicker">THE PROBLEM</p>
        <h2>You built the website.<br /><em>You shouldn’t have to become an SEO expert.</em></h2>
        <p>Building and deploying is easier than ever. But getting discovered — and understanding whether your website is working — still asks too much of the people making the web.</p>
        <div className="progression"><span>Build</span><i>→</i><span>Deploy</span><i>→</i><b>Paste your URL</b><i>→</i><span>Understand</span><i>→</i><span>Grow</span></div>
      </section>

      <section className="feature-split wrap" id="how">
        <div className="split-copy">
          <p className="section-kicker">START WITH A URL</p>
          <h2>Just enough<br />to know what’s next.</h2>
          <p>Three quiet steps between a launched site and a clear plan.</p>
          <ol><li><b>01</b> Paste your website</li><li><b>02</b> GrowthSent scans it</li><li><b>03</b> Get instant insights</li></ol>
          <a className="text-link" href="#start">See what needs fixing <span>→</span></a>
        </div>
        <div className="finding-board">
          <div className="browser-bar"><span /><span /><span /><b>growthsent.com/report</b></div>
          <div className="findings-content">
            <div className="finding-head">
              <p>YOUR FIRST REPORT</p>
              <h3>{activeScan?.summaryMetrics
                ? <>This audit found <u>{activeScan.summaryMetrics.criticalIssues + activeScan.summaryMetrics.highIssues + activeScan.summaryMetrics.mediumIssues} issues</u><br />to review.</>
                : <>Your first audit reports<br /><u>only what it measures.</u></>}</h3>
            </div>
            <div className="finding-row critical"><span>↗</span><div><b>Important</b><p>{activeScan?.summaryMetrics ? `${activeScan.summaryMetrics.criticalIssues} critical issues detected` : "Run a scan to identify indexing issues"}</p></div><em style={{ cursor: "pointer" }} onClick={handleOpenReport}>View</em></div>
            <div className="finding-row recommend"><span>↗</span><div><b>Recommended</b><p>{activeScan?.summaryMetrics ? `${activeScan.summaryMetrics.highIssues} high priority recommendations` : "Run a scan to get recommendations"}</p></div><em style={{ cursor: "pointer" }} onClick={handleOpenReport}>View</em></div>
            <div className="finding-row healthy"><span>—</span><div><b>Bounded coverage</b><p>Up to 25 public pages per audit</p></div><em>—</em></div>
          </div>
        </div>
      </section>

      <section className="console-section">
        <div className="wrap">
          <div className="center-heading">
            <p className="section-kicker">ONE QUIET CONSOLE</p>
            <h2>Your website’s<br />command centre.</h2>
            <p>SEO health, analytics, search visibility, and growth opportunities — simply arranged in one place.</p>
          </div>
          <div className="console-preview" style={{ padding: "44px", textAlign: "center" }}>
            <p className="section-kicker">START WITH YOUR DATA</p>
            <h3 style={{ margin: "12px 0" }}>Your dashboard starts empty.</h3>
            <button className="primary-btn" onClick={() => setShowAuthModal(true)} style={{ background: "#a4ef51", color: "#171817", fontWeight: 800, padding: "12px 28px", border: "none", borderRadius: "8px", cursor: "pointer", fontSize: "14px", marginTop: "12px" }}>Create an account →</button>
          </div>
        </div>
      </section>

      <section className="integration wrap">
        <div>
          <p className="section-kicker">GOOGLE IS OPTIONAL</p>
          <h2>You don’t need Google Search Console to get started.</h2>
          <p>GrowthSent starts with bounded technical audits. Connect the tools you already use when you want deeper search and visitor insight.</p>
        </div>
        <div className="integration-map">
          <div className="site-node"><span>⌁</span><b>Your website</b><small>Public website data</small></div>
          <i className="downline">↓</i>
          <div className="gs-node"><Logo dark /><small>Your growth console</small></div>
          <p>OPTIONAL ENRICHMENT</p>
          <div className="google-nodes"><span><GscIcon /> Google Search Console</span><span><GaIcon /> Google Analytics</span></div>
        </div>
      </section>

      <section className="recommendation wrap">
        <div className="rec-card">
          <div className="rec-top"><span>✦&nbsp; OPPORTUNITY FOUND</span><small>For /pricing</small></div>
          <h3>Your pricing page received <mark>4,200 search impressions</mark> but only 0.4% of visitors clicked.</h3>
          <div className="potential">
            <b>Potential improvement</b>
            <p>Improve your search title and description.</p>
            <span>Simple Website Analytics &amp; SEO for Solo Founders</span>
          </div>
          <footer>
            <button>✦ Apply suggestion</button>
            <a>View details →</a>
          </footer>
        </div>
        <div className="rec-copy">
          <p className="section-kicker">KNOW WHAT TO DO NEXT</p>
          <h2>Data is useful.<br /><em>Direction is better.</em></h2>
          <p>GrowthSent explains what your data means, then points to the change most worth making.</p>
        </div>
      </section>

      <section className="magic">
        <div className="narrow">
          <p className="section-kicker">MAGIC FIXES</p>
          <h2>See the problem.<br />Fix the problem.<br /><em>Move on.</em></h2>
          <p>Let the signal travel from a website issue to your coding environment — without turning your growth work into a second job.</p>
          <div className="magic-flow"><span>GrowthSent finds it</span><i>→</i><span>Explains it</span><i>→</i><b>+ You fix it</b><i>→</i><span>Deploy</span><i>→</i><span>Checks again</span></div>
          <div className="tool-row"><span>Fix with</span><b><ClaudeIcon /> Claude Code</b><b><CursorIcon /> Cursor</b><b><CodexIcon /> Codex</b></div>
        </div>
      </section>

      <section className="for-builders wrap">
        <p className="section-kicker">BUILT FOR PEOPLE WHO JUST SHIPPED</p>
        <div className="quote-grid">
          <p>“I just launched<br />my SaaS.”</p>
          <p>“I built my site<br />with AI.”</p>
          <p>“I have no idea if<br />Google can find me.”</p>
          <p>“I don’t want to<br />learn SEO.”</p>
        </div>
        <h2>That’s exactly why<br /><em>GrowthSent exists.</em></h2>
      </section>

      <section className="final-cta">
        <p className="section-kicker">START WITH A SINGLE URL</p>
        <h2>Your website is live.<br />Now make sure people can find it.</h2>
        <p>Paste your URL and get your first GrowthSent report for free.</p>
        <UrlBar dark onScanResult={(res) => setActiveScan(res)} />
        <small>No login required.</small>
      </section>

      <footer className="footer wrap">
        <div className="footer-brand">
          <Logo dark />
          <p>The calm command centre for<br />the website you just shipped.</p>
          <small>
            © 2026 GrowthSent ·{" "}
            <a
              href="/privacy"
              style={{ cursor: "pointer", textDecoration: "underline" }}
              onClick={(e) => {
                e.preventDefault();
                navigateTo("/privacy");
              }}
            >
              Privacy Policy
            </a>
            {" · "}
            <a
              href="/terms"
              style={{ cursor: "pointer", textDecoration: "underline" }}
              onClick={(e) => {
                e.preventDefault();
                navigateTo("/terms");
              }}
            >
              Terms of Service
            </a>
          </small>
        </div>
        <div><b>Product</b><a>Technical audits</a><a>Common Crawl preview</a></div>
        <div id="developers"><b>Preview</b><a>Bounded audits</a><a>Public website data</a></div>
        <div>
          <b>Company</b>
          <a>About</a>
          <a href="/pricing" style={{ cursor: "pointer" }} onClick={(e) => { e.preventDefault(); navigateTo("/pricing"); }}>Pricing</a>
          <a
            href="/privacy"
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              navigateTo("/privacy");
            }}
          >
            Privacy Policy
          </a>
          <a
            href="/terms"
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              navigateTo("/terms");
            }}
          >
            Terms of Service
          </a>
        </div>
        <div><b>Social</b><a>𝕏 Twitter</a><a>GitHub</a><a>LinkedIn</a></div>
      </footer>

      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          initialError={authRedirectError}
          onAuthenticated={(u) => {
            setUser(u);
            setShowAuthModal(false);
          }}
        />
      )}
    </main>
  );
}

export default function RootApp() {
  return <App />;
}
