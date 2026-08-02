import React, { useMemo, useState } from "react";
import { TableSkeleton } from "./SkeletonLoaders";

interface PagesViewProps {
  activeSite?: string;
  isScanning?: boolean;
  scanResult?: { pages?: Array<any>; scan?: { completionTime?: string } } | null;
}

export function PagesView({ activeSite, isScanning = false, scanResult }: PagesViewProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const pages = scanResult?.pages || [];

  const visiblePages = useMemo(
    () => pages.filter((page) => {
      const matchesSearch = page.url?.toLowerCase().includes(searchTerm.toLowerCase())
        || page.title?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "all" || String(page.statusCode) === statusFilter;
      return matchesSearch && matchesStatus;
    }),
    [pages, searchTerm, statusFilter]
  );

  return (
    <div className="pages-view">
      <div className="console-title flex-between">
        <div>
          <h3 className="title-text">Pages{activeSite ? ` for ${activeSite}` : ""}</h3>
          <p className="card-sub">Pages discovered during the latest completed crawl.</p>
        </div>
        <span className="card-sub">{pages.length} discovered</span>
      </div>

      {isScanning ? (
        <div style={{ marginTop: "20px" }}><TableSkeleton /></div>
      ) : pages.length === 0 ? (
        <div className="console-section-card" style={{ marginTop: "20px", padding: "40px", textAlign: "center" }}>
          <h4 className="card-title">No crawled pages yet</h4>
          <p className="card-sub">Run a scan to populate this list with real page, metadata, and response information.</p>
        </div>
      ) : (
        <div className="console-section-card" style={{ marginTop: "20px" }}>
          <div className="card-header flex-between" style={{ gap: "12px", flexWrap: "wrap" }}>
            <input
              className="form-input"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Filter by URL or title"
              style={{ maxWidth: "320px" }}
            />
            <select className="filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All response codes</option>
              <option value="200">200 OK</option>
              <option value="301">301 Redirect</option>
              <option value="404">404 Not Found</option>
              <option value="500">500 Server Error</option>
            </select>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr><th>URL</th><th>Status</th><th>Title</th><th>Response</th><th>Indexing</th></tr>
              </thead>
              <tbody>
                {visiblePages.map((page) => (
                  <tr key={page._id?.toString?.() || page.normalizedUrl || page.url}>
                    <td><a href={page.url} target="_blank" rel="noreferrer" className="url-link-text">{page.url}</a></td>
                    <td><span className={page.statusCode >= 400 ? "badge-status fail" : "badge-status pass"}>{page.statusCode}</span></td>
                    <td>{page.title || "No title"}</td>
                    <td>{page.responseTimeMs ?? 0} ms</td>
                    <td>{page.isNoindex ? "Noindex" : "Indexable"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visiblePages.length === 0 && <p className="card-sub" style={{ padding: "20px" }}>No crawled pages match these filters.</p>}
        </div>
      )}
    </div>
  );
}
