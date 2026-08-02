import { fetchUrl } from "./fetcher";

export interface RobotsTxtResult {
  exists: boolean;
  accessible: boolean;
  statusCode: number;
  sitemaps: string[];
  disallowedPaths: string[];
  allowedPaths: string[];
  rawText: string;
}

export async function fetchAndParseRobotsTxt(originUrl: string): Promise<RobotsTxtResult> {
  const parsed = new URL(originUrl);
  const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;

  const fetchRes = await fetchUrl(robotsUrl, { timeoutMs: 5000 });

  if (fetchRes.statusCode !== 200 || !fetchRes.body) {
    return {
      exists: false,
      accessible: fetchRes.statusCode > 0,
      statusCode: fetchRes.statusCode,
      sitemaps: [],
      disallowedPaths: [],
      allowedPaths: [],
      rawText: "",
    };
  }

  const sitemaps: string[] = [];
  const disallowedPaths: string[] = [];
  const allowedPaths: string[] = [];

  const lines = fetchRes.body.split(/\r?\n/);
  let isTargetAgent = true; // Applies to * or GrowthSentBot

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(":");
    if (parts.length < 2) continue;

    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();

    if (key === "user-agent") {
      isTargetAgent = value === "*" || value.toLowerCase().includes("growthsent");
    } else if (key === "sitemap") {
      if (value.startsWith("http://") || value.startsWith("https://")) {
        sitemaps.push(value);
      }
    } else if (isTargetAgent) {
      if (key === "disallow" && value) {
        disallowedPaths.push(value);
      } else if (key === "allow" && value) {
        allowedPaths.push(value);
      }
    }
  }

  return {
    exists: true,
    accessible: true,
    statusCode: fetchRes.statusCode,
    sitemaps: Array.from(new Set(sitemaps)),
    disallowedPaths,
    allowedPaths,
    rawText: fetchRes.body,
  };
}

export function isPathDisallowedByRobots(path: string, disallowedPaths: string[], allowedPaths: string[]): boolean {
  // Simple path prefix matching for robots rules
  for (const allow of allowedPaths) {
    if (allow && path.startsWith(allow)) return false;
  }
  for (const disallow of disallowedPaths) {
    if (disallow === "/") return true;
    if (disallow && path.startsWith(disallow)) return true;
  }
  return false;
}
