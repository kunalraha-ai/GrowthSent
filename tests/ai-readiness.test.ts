import assert from "node:assert/strict";
import test from "node:test";
import { handleApiRequest } from "../lib/api/router";
import { buildAiReadinessReport } from "../lib/ai-readiness/service";
import type { FetchResult } from "../lib/crawler/fetcher";

function response(url: string, options: Partial<FetchResult> = {}): FetchResult {
  return {
    url,
    finalUrl: options.finalUrl ?? url,
    statusCode: options.statusCode ?? 404,
    responseTimeMs: options.responseTimeMs ?? 4,
    contentType: options.contentType ?? "text/plain",
    body: options.body ?? "",
    pageSizeBytes: options.pageSizeBytes ?? (options.body ?? "").length,
    redirectChain: options.redirectChain ?? [url],
    failureCategory: options.failureCategory,
    error: options.error,
  };
}

test("AI readiness report is calculated exclusively from fetched public evidence", async () => {
  const homepage = "https://example.com/";
  const content = "A useful public explanation ".repeat(24);
  const responses = new Map<string, FetchResult>([
    [homepage, response(homepage, {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      body: `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script></head><body><main><h1>Example</h1><p>${content}</p></main></body></html>`,
    })],
    ["https://example.com/robots.txt", response("https://example.com/robots.txt", {
      statusCode: 200,
      contentType: "text/plain",
      body: "User-agent: GPTBot\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n",
    })],
    ["https://example.com/llms.txt", response("https://example.com/llms.txt", { statusCode: 200, body: "# Example\n> Public product documentation" })],
    ["https://example.com/openapi.json", response("https://example.com/openapi.json", { statusCode: 200, contentType: "application/json", body: '{"openapi":"3.1.0","info":{"title":"Example"}}' })],
    ["https://example.com/.well-known/openid-configuration", response("https://example.com/.well-known/openid-configuration", { statusCode: 200, contentType: "application/json", body: '{"authorization_endpoint":"https://example.com/authorize","token_endpoint":"https://example.com/token"}' })],
    ["https://example.com/.well-known/agent-card.json", response("https://example.com/.well-known/agent-card.json", { statusCode: 200, contentType: "application/json", body: '{"name":"Example Agent","url":"https://example.com/agent","version":"1.0.0"}' })],
  ]);

  const report = await buildAiReadinessReport(homepage, {
    fetch: async (url) => responses.get(url) ?? response(url),
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });

  assert.equal(report.kind, "growthsent-ai-readiness-report");
  assert.equal(report.generatedAt, "2026-08-29T10:00:00.000Z");
  assert.equal(report.score.value, 100);
  assert.equal(report.score.coveragePercent, 100);
  assert.equal(report.summary.ready, 8);
  assert.equal(report.summary.needsAttention, 0);
  assert.equal(report.summary.unavailable, 0);
  assert.match(report.checks.find((check) => check.id === "ai_crawler_policy")?.evidence || "", /GPTBot/);
  assert.match(report.checks.find((check) => check.id === "structured_entity_signals")?.evidence || "", /Organization/);
});

test("AI readiness treats confirmed absences as attention items and transport failures as unscored", async () => {
  const homepage = "https://example.com/";
  const responses = new Map<string, FetchResult>([
    [homepage, response(homepage, { statusCode: 200, contentType: "text/html", body: "<html><body><h1>Example</h1><main>" + "Meaningful content. ".repeat(20) + "</main></body></html>" })],
    ["https://example.com/robots.txt", response("https://example.com/robots.txt", { statusCode: 404 })],
    ["https://example.com/sitemap.xml", response("https://example.com/sitemap.xml", { statusCode: 404 })],
    ["https://example.com/sitemap_index.xml", response("https://example.com/sitemap_index.xml", { statusCode: 404 })],
    ["https://example.com/llms.txt", response("https://example.com/llms.txt", { statusCode: 404 })],
    ["https://example.com/openapi.json", response("https://example.com/openapi.json", { statusCode: 0, failureCategory: "timeout" })],
    ["https://example.com/.well-known/openapi.json", response("https://example.com/.well-known/openapi.json", { statusCode: 0, failureCategory: "timeout" })],
    ["https://example.com/.well-known/oauth-authorization-server", response("https://example.com/.well-known/oauth-authorization-server", { statusCode: 404 })],
    ["https://example.com/.well-known/openid-configuration", response("https://example.com/.well-known/openid-configuration", { statusCode: 404 })],
    ["https://example.com/.well-known/agent-card.json", response("https://example.com/.well-known/agent-card.json", { statusCode: 200, contentType: "text/html", body: "<html><body>Application shell</body></html>" })],
  ]);

  const report = await buildAiReadinessReport(homepage, {
    fetch: async (url) => responses.get(url) ?? response(url),
  });

  assert.equal(report.checks.find((check) => check.id === "ai_crawler_policy")?.status, "needs_attention");
  assert.equal(report.checks.find((check) => check.id === "api_description")?.status, "unavailable");
  assert.equal(report.checks.find((check) => check.id === "readable_primary_content")?.status, "ready");
  assert.equal(report.checks.find((check) => check.id === "a2a_agent_card")?.status, "needs_attention");
  assert.equal(report.score.coveragePercent < 100, true);
  assert.equal(report.score.value === null, false);
});

test("AI readiness refuses to evaluate a homepage redirected outside the saved website scope", async () => {
  const report = await buildAiReadinessReport("https://example.com/", {
    fetch: async (url) => response(url, { statusCode: 200, finalUrl: "https://unrelated.example/", contentType: "text/html", body: "<html></html>" }),
  });

  assert.equal(report.score.value, null);
  assert.equal(report.score.coveragePercent, 0);
  assert.equal(report.summary.unavailable, 8);
  assert.match(report.checks[0].evidence, /outside the website's www\/apex scope/i);
});

test("AI readiness API requires an authenticated application session", async () => {
  const response = await handleApiRequest({
    method: "POST",
    path: "/api/v1/websites/0123456789abcdef01234567/ai-readiness",
    query: {},
    body: null,
    headers: {},
    ip: "203.0.113.254",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");
});
