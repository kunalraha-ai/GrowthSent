import * as cheerio from "cheerio";
import { fetchUrl, type FetchOptions, type FetchResult } from "../crawler/fetcher.js";
import { parsePageHtml } from "../crawler/parser.js";
import { isUrlWithinCrawlOriginScope } from "../domain/registrable.js";

export type AiReadinessStatus = "ready" | "needs_attention" | "unavailable";
export type AiReadinessPriority = "High impact" | "Foundation" | "Advanced";

export interface AiReadinessCheck {
  id: string;
  group: string;
  title: string;
  description: string;
  priority: AiReadinessPriority;
  weight: number;
  status: AiReadinessStatus;
  evidence: string;
  recommendation: string;
}

export interface AiReadinessReport {
  kind: "growthsent-ai-readiness-report";
  generatedAt: string;
  target: { url: string; hostname: string };
  score: {
    value: number | null;
    coveragePercent: number;
    observedWeight: number;
    totalWeight: number;
  };
  summary: {
    ready: number;
    needsAttention: number;
    unavailable: number;
  };
  checks: AiReadinessCheck[];
}

export interface AiReadinessDependencies {
  fetch?: (url: string, options?: FetchOptions) => Promise<FetchResult>;
  now?: () => Date;
}

interface CheckDefinition {
  id: string;
  group: string;
  title: string;
  description: string;
  priority: AiReadinessPriority;
  weight: number;
  recommendation: string;
}

const FETCH_OPTIONS: FetchOptions = {
  timeoutMs: 5_000,
  maxSizeBytes: 256 * 1024,
  maxRedirects: 3,
  userAgent: "GrowthSentAIReadiness/1.0 (+https://growthsent.com)",
};

const MAX_PARALLEL_REQUESTS = 3;
const AI_CRAWLER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Google-Extended",
] as const;

const CHECKS = {
  crawlerPolicy: {
    id: "ai_crawler_policy",
    group: "Discoverability",
    title: "AI crawler access policy",
    description: "Checks whether robots.txt has an explicit policy for recognised AI crawlers.",
    priority: "High impact",
    weight: 20,
    recommendation: "Add explicit robots.txt rules for the AI crawlers you intend to allow or block.",
  },
  sitemap: {
    id: "sitemap_discovery",
    group: "Discoverability",
    title: "Sitemap discovery",
    description: "Checks for a sitemap declaration or a valid standard sitemap document.",
    priority: "High impact",
    weight: 15,
    recommendation: "Publish a valid XML sitemap and declare it in robots.txt where possible.",
  },
  llms: {
    id: "ai_site_guide",
    group: "Discoverability",
    title: "AI-readable site guide",
    description: "Checks for a public llms.txt guide that points agents to useful content.",
    priority: "Foundation",
    weight: 10,
    recommendation: "Publish a concise llms.txt file that links to the most useful public pages.",
  },
  readableContent: {
    id: "readable_primary_content",
    group: "Content signals",
    title: "Readable primary content",
    description: "Checks that the homepage exposes a primary heading and meaningful readable content.",
    priority: "High impact",
    weight: 15,
    recommendation: "Give important pages one clear H1 and enough meaningful public text to answer a visitor's question.",
  },
  structuredData: {
    id: "structured_entity_signals",
    group: "Content signals",
    title: "Structured entity signals",
    description: "Checks for parseable structured data on the homepage.",
    priority: "Foundation",
    weight: 15,
    recommendation: "Add valid JSON-LD or other structured data that identifies your organisation, content, and products.",
  },
  apiDescription: {
    id: "api_description",
    group: "Agent actions",
    title: "Machine-readable API description",
    description: "Looks for a public OpenAPI description at common same-origin locations.",
    priority: "Advanced",
    weight: 10,
    recommendation: "Publish an OpenAPI description if agents should be able to discover safe API actions.",
  },
  authDiscovery: {
    id: "agent_auth_discovery",
    group: "Agent actions",
    title: "Agent sign-in discovery",
    description: "Looks for public OAuth or OpenID Connect discovery metadata.",
    priority: "Advanced",
    weight: 7,
    recommendation: "Expose OAuth or OpenID Connect discovery metadata if agents need a trusted sign-in path.",
  },
  agentCard: {
    id: "a2a_agent_card",
    group: "Agent actions",
    title: "A2A agent card",
    description: "Looks for a public Agent2Agent card at the standard well-known path.",
    priority: "Advanced",
    weight: 8,
    recommendation: "Publish a valid A2A agent card when your product exposes agent-facing capabilities.",
  },
} satisfies Record<string, CheckDefinition>;

type NamedFetch = { name: string; url: string };

function emptyFetchResult(url: string): FetchResult {
  return {
    url,
    finalUrl: url,
    statusCode: 0,
    responseTimeMs: 0,
    contentType: "",
    body: "",
    pageSizeBytes: 0,
    redirectChain: [url],
    failureCategory: "network",
    error: "Network request failed.",
  };
}

async function fetchMany(
  fetcher: NonNullable<AiReadinessDependencies["fetch"]>,
  targets: NamedFetch[]
): Promise<Map<string, FetchResult>> {
  const results = new Map<string, FetchResult>();
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      try {
        results.set(target.name, await fetcher(target.url, FETCH_OPTIONS));
      } catch {
        results.set(target.name, emptyFetchResult(target.url));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_REQUESTS, targets.length) }, () => worker()));
  return results;
}

function makeCheck(definition: CheckDefinition, status: AiReadinessStatus, evidence: string): AiReadinessCheck {
  return { ...definition, status, evidence };
}

function unavailable(definition: CheckDefinition, label: string, result?: FetchResult): AiReadinessCheck {
  if (!result || result.statusCode === 0) {
    return makeCheck(definition, "unavailable", `${label} could not be reached safely, so this check was not scored.`);
  }
  return makeCheck(definition, "unavailable", `${label} returned HTTP ${result.statusCode}, so this check was not scored.`);
}

function isHtmlResult(result: FetchResult): boolean {
  return result.contentType.toLowerCase().includes("html") || /<html[\s>]/i.test(result.body.slice(0, 512));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isJsonResult(result: FetchResult): boolean {
  return result.contentType.toLowerCase().includes("json") || /^[\s\n\r]*[\[{]/.test(result.body);
}

function declaredSitemapCount(robotsText: string): number {
  const declarations = new Set<string>();
  for (const line of robotsText.split(/\r?\n/)) {
    const value = line.replace(/#.*/, "").trim();
    const match = /^sitemap\s*:\s*(https?:\/\/\S+)\s*$/i.exec(value);
    if (match) declarations.add(match[1]);
  }
  return declarations.size;
}

function explicitAiCrawlerAgents(robotsText: string): string[] {
  const namedAgents = new Set<string>();
  let hasDirective = false;
  let groupAgents: string[] = [];

  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      if (hasDirective) {
        groupAgents = [];
        hasDirective = false;
      }
      if (value) groupAgents.push(value.toLowerCase());
      continue;
    }

    if (key === "allow" || key === "disallow") {
      hasDirective = true;
      for (const knownAgent of AI_CRAWLER_AGENTS) {
        if (groupAgents.includes(knownAgent.toLowerCase())) namedAgents.add(knownAgent);
      }
    }
  }

  return AI_CRAWLER_AGENTS.filter((agent) => namedAgents.has(agent));
}

function evaluateCrawlerPolicy(robots: FetchResult): AiReadinessCheck {
  if (robots.statusCode === 404) {
    return makeCheck(CHECKS.crawlerPolicy, "needs_attention", "robots.txt returned HTTP 404; no explicit AI crawler policy was found.");
  }
  if (robots.statusCode !== 200 || !robots.body) return unavailable(CHECKS.crawlerPolicy, "robots.txt", robots);

  const namedAgents = explicitAiCrawlerAgents(robots.body);
  if (namedAgents.length > 0) {
    return makeCheck(CHECKS.crawlerPolicy, "ready", `robots.txt contains explicit rules for ${namedAgents.join(", ")}.`);
  }
  return makeCheck(CHECKS.crawlerPolicy, "needs_attention", "robots.txt has no explicit rules for the recognised AI crawlers checked by this audit.");
}

function isSitemapDocument(result: FetchResult): boolean {
  return result.statusCode === 200 && /<(?:urlset|sitemapindex)[\s>]/i.test(result.body);
}

function evaluateSitemap(robots: FetchResult, sitemap: FetchResult, sitemapIndex: FetchResult): AiReadinessCheck {
  const robotsSitemaps = robots.statusCode === 200 ? declaredSitemapCount(robots.body) : 0;
  if (robotsSitemaps > 0) {
    return makeCheck(CHECKS.sitemap, "ready", `robots.txt declares ${robotsSitemaps} sitemap location${robotsSitemaps === 1 ? "" : "s"}.`);
  }
  if (isSitemapDocument(sitemap)) {
    return makeCheck(CHECKS.sitemap, "ready", "A valid sitemap document was found at /sitemap.xml.");
  }
  if (isSitemapDocument(sitemapIndex)) {
    return makeCheck(CHECKS.sitemap, "ready", "A valid sitemap index was found at /sitemap_index.xml.");
  }
  if (sitemap.statusCode === 404 && sitemapIndex.statusCode === 404) {
    return makeCheck(CHECKS.sitemap, "needs_attention", "Neither /sitemap.xml nor /sitemap_index.xml returned a sitemap document.");
  }
  if (sitemap.statusCode === 200 || sitemapIndex.statusCode === 200) {
    return makeCheck(CHECKS.sitemap, "needs_attention", "A standard sitemap path responded, but no valid sitemap XML document was found.");
  }
  return unavailable(CHECKS.sitemap, "Standard sitemap locations", sitemap.statusCode === 0 ? sitemap : sitemapIndex);
}

function evaluateLlmsGuide(llms: FetchResult): AiReadinessCheck {
  if (llms.statusCode === 404) {
    return makeCheck(CHECKS.llms, "needs_attention", "No public llms.txt guide was found at /llms.txt.");
  }
  if (llms.statusCode !== 200 || !llms.body.trim()) return unavailable(CHECKS.llms, "llms.txt", llms);
  return makeCheck(CHECKS.llms, "ready", `A public llms.txt guide was found with ${llms.body.trim().length} readable characters.`);
}

function evaluateReadableContent(home: FetchResult): AiReadinessCheck {
  if (home.statusCode !== 200 || !home.body) return unavailable(CHECKS.readableContent, "Homepage", home);
  if (!isHtmlResult(home)) {
    return makeCheck(CHECKS.readableContent, "needs_attention", "The homepage returned HTTP 200 but did not look like an HTML document.");
  }

  const parsed = parsePageHtml(home.body, home.finalUrl);
  const $ = cheerio.load(home.body);
  $("script, style, noscript, template").remove();
  const readableCharacterCount = $("main, article, [role='main']").text().replace(/\s+/g, " ").trim().length || $("body").text().replace(/\s+/g, " ").trim().length;
  const hasMainRegion = $("main, article, [role='main']").length > 0;

  if (!parsed.isNoindex && parsed.headings.h1.length > 0 && readableCharacterCount >= 240) {
    return makeCheck(
      CHECKS.readableContent,
      "ready",
      `Homepage has ${parsed.headings.h1.length} H1 heading${parsed.headings.h1.length === 1 ? "" : "s"}, ${readableCharacterCount} readable characters, and${hasMainRegion ? "" : " no explicit"} main content region.`
    );
  }

  const missingSignals = [
    ...(parsed.isNoindex ? ["a noindex directive"] : []),
    ...(parsed.headings.h1.length === 0 ? ["an H1 heading"] : []),
    ...(readableCharacterCount < 240 ? ["enough readable page content"] : []),
  ];
  return makeCheck(CHECKS.readableContent, "needs_attention", `Homepage is missing ${missingSignals.join(", ") || "a required content signal"}.`);
}

function evaluateStructuredData(home: FetchResult): AiReadinessCheck {
  if (home.statusCode !== 200 || !home.body) return unavailable(CHECKS.structuredData, "Homepage", home);
  if (!isHtmlResult(home)) return unavailable(CHECKS.structuredData, "Homepage HTML", home);

  const parsed = parsePageHtml(home.body, home.finalUrl);
  if (!parsed.jsonLdSyntaxValid) {
    return makeCheck(CHECKS.structuredData, "needs_attention", "The homepage contains JSON-LD that could not be parsed safely.");
  }
  if (parsed.structuredDataTypes.length === 0) {
    return makeCheck(CHECKS.structuredData, "needs_attention", "No JSON-LD, Microdata, or RDFa structured data was found on the homepage.");
  }
  return makeCheck(CHECKS.structuredData, "ready", `Homepage exposes ${parsed.structuredDataTypes.join(", ")} structured data signal${parsed.structuredDataTypes.length === 1 ? "" : "s"}.`);
}

function evaluateApiDescription(openApi: FetchResult, wellKnownOpenApi: FetchResult): AiReadinessCheck {
  const candidates = [openApi, wellKnownOpenApi];
  for (const candidate of candidates) {
    if (candidate.statusCode !== 200 || !isJsonResult(candidate)) continue;
    const document = parseJsonObject(candidate.body);
    if (typeof document?.openapi === "string" || typeof document?.swagger === "string") {
      const path = new URL(candidate.finalUrl).pathname;
      return makeCheck(CHECKS.apiDescription, "ready", `A machine-readable API description was found at ${path}.`);
    }
  }
  if (candidates.every((candidate) => candidate.statusCode === 404)) {
    return makeCheck(CHECKS.apiDescription, "needs_attention", "No OpenAPI description was found at /openapi.json or /.well-known/openapi.json.");
  }
  if (candidates.some((candidate) => candidate.statusCode === 200)) {
    return makeCheck(CHECKS.apiDescription, "needs_attention", "A possible API description endpoint responded, but it did not contain a valid OpenAPI document.");
  }
  return unavailable(CHECKS.apiDescription, "OpenAPI discovery endpoints", candidates.find((candidate) => candidate.statusCode !== 0));
}

function isOAuthDiscoveryDocument(document: Record<string, unknown> | null): boolean {
  return typeof document?.authorization_endpoint === "string" && typeof document?.token_endpoint === "string";
}

function evaluateAuthDiscovery(oauth: FetchResult, openId: FetchResult): AiReadinessCheck {
  const candidates = [oauth, openId];
  for (const candidate of candidates) {
    if (candidate.statusCode !== 200 || !isJsonResult(candidate)) continue;
    if (isOAuthDiscoveryDocument(parseJsonObject(candidate.body))) {
      const path = new URL(candidate.finalUrl).pathname;
      return makeCheck(CHECKS.authDiscovery, "ready", `OAuth or OpenID Connect discovery metadata was found at ${path}.`);
    }
  }
  if (candidates.every((candidate) => candidate.statusCode === 404)) {
    return makeCheck(CHECKS.authDiscovery, "needs_attention", "No OAuth or OpenID Connect discovery metadata was found at the standard well-known paths.");
  }
  if (candidates.some((candidate) => candidate.statusCode === 200)) {
    return makeCheck(CHECKS.authDiscovery, "needs_attention", "A discovery endpoint responded, but it did not expose both authorization and token endpoints.");
  }
  return unavailable(CHECKS.authDiscovery, "OAuth discovery endpoints", candidates.find((candidate) => candidate.statusCode !== 0));
}

function evaluateAgentCard(agentCard: FetchResult): AiReadinessCheck {
  if (agentCard.statusCode === 404) {
    return makeCheck(CHECKS.agentCard, "needs_attention", "No A2A agent card was found at /.well-known/agent-card.json.");
  }
  if (agentCard.statusCode !== 200) return unavailable(CHECKS.agentCard, "A2A agent card", agentCard);
  if (!isJsonResult(agentCard)) {
    return makeCheck(CHECKS.agentCard, "needs_attention", "The A2A agent card endpoint returned HTTP 200 but not a JSON agent card.");
  }

  const document = parseJsonObject(agentCard.body);
  if (typeof document?.name === "string" && typeof document?.url === "string" && typeof document?.version === "string") {
    return makeCheck(CHECKS.agentCard, "ready", "A public A2A agent card with name, URL, and version fields was found.");
  }
  return makeCheck(CHECKS.agentCard, "needs_attention", "An A2A agent card endpoint responded, but it did not include the required name, URL, and version fields.");
}

function reportFromChecks(targetUrl: string, checks: AiReadinessCheck[], generatedAt: Date): AiReadinessReport {
  const totalWeight = checks.reduce((total, check) => total + check.weight, 0);
  const observed = checks.filter((check) => check.status !== "unavailable");
  const observedWeight = observed.reduce((total, check) => total + check.weight, 0);
  const readyWeight = observed.filter((check) => check.status === "ready").reduce((total, check) => total + check.weight, 0);
  const score = observedWeight > 0 ? Math.round((readyWeight / observedWeight) * 100) : null;
  const target = new URL(targetUrl);

  return {
    kind: "growthsent-ai-readiness-report",
    generatedAt: generatedAt.toISOString(),
    target: { url: targetUrl, hostname: target.hostname },
    score: {
      value: score,
      coveragePercent: totalWeight > 0 ? Math.round((observedWeight / totalWeight) * 100) : 0,
      observedWeight,
      totalWeight,
    },
    summary: {
      ready: checks.filter((check) => check.status === "ready").length,
      needsAttention: checks.filter((check) => check.status === "needs_attention").length,
      unavailable: checks.filter((check) => check.status === "unavailable").length,
    },
    checks,
  };
}

function unavailableReport(targetUrl: string, evidence: string, generatedAt: Date): AiReadinessReport {
  return reportFromChecks(
    targetUrl,
    Object.values(CHECKS).map((definition) => makeCheck(definition, "unavailable", evidence)),
    generatedAt
  );
}

export async function buildAiReadinessReport(targetUrl: string, dependencies: AiReadinessDependencies = {}): Promise<AiReadinessReport> {
  const requested = new URL(targetUrl);
  if (requested.protocol !== "http:" && requested.protocol !== "https:") {
    throw new Error("AI readiness audits require an HTTP or HTTPS website URL.");
  }
  const requestedOrigin = `${requested.protocol}//${requested.host}/`;
  const fetcher = dependencies.fetch ?? fetchUrl;
  const now = dependencies.now ?? (() => new Date());
  const home = await fetcher(requestedOrigin, FETCH_OPTIONS);

  if (home.statusCode !== 0 && !isUrlWithinCrawlOriginScope(requestedOrigin, home.finalUrl)) {
    return unavailableReport(
      requestedOrigin,
      "Homepage redirects outside the website's www/apex scope, so no AI readiness signals were evaluated.",
      now()
    );
  }

  let origin = requestedOrigin;
  try {
    if (home.statusCode > 0 && isUrlWithinCrawlOriginScope(requestedOrigin, home.finalUrl)) {
      const final = new URL(home.finalUrl);
      origin = `${final.protocol}//${final.host}/`;
    }
  } catch {
    // fetchUrl already validates redirects. Retain the requested origin if a
    // malformed test double reaches this boundary.
  }

  const resources = await fetchMany(fetcher, [
    { name: "robots", url: new URL("/robots.txt", origin).toString() },
    { name: "sitemap", url: new URL("/sitemap.xml", origin).toString() },
    { name: "sitemapIndex", url: new URL("/sitemap_index.xml", origin).toString() },
    { name: "llms", url: new URL("/llms.txt", origin).toString() },
    { name: "openApi", url: new URL("/openapi.json", origin).toString() },
    { name: "wellKnownOpenApi", url: new URL("/.well-known/openapi.json", origin).toString() },
    { name: "oauth", url: new URL("/.well-known/oauth-authorization-server", origin).toString() },
    { name: "openId", url: new URL("/.well-known/openid-configuration", origin).toString() },
    { name: "agentCard", url: new URL("/.well-known/agent-card.json", origin).toString() },
  ]);

  const result = (name: string) => resources.get(name) ?? emptyFetchResult(new URL("/", origin).toString());
  const checks = [
    evaluateCrawlerPolicy(result("robots")),
    evaluateSitemap(result("robots"), result("sitemap"), result("sitemapIndex")),
    evaluateLlmsGuide(result("llms")),
    evaluateReadableContent(home),
    evaluateStructuredData(home),
    evaluateApiDescription(result("openApi"), result("wellKnownOpenApi")),
    evaluateAuthDiscovery(result("oauth"), result("openId")),
    evaluateAgentCard(result("agentCard")),
  ];

  return reportFromChecks(origin, checks, now());
}
