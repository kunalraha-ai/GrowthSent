import { fetchUrl } from "./fetcher.js";

export interface SitemapParseResult {
  exists: boolean;
  accessible: boolean;
  statusCode: number;
  urls: string[];
  sitemapIndexUrls: string[];
  errors: string[];
}

export async function fetchAndParseSitemap(
  originUrl: string,
  customSitemapUrls: string[] = []
): Promise<SitemapParseResult> {
  const parsedOrigin = new URL(originUrl);
  const candidateUrls = new Set<string>();

  if (customSitemapUrls.length > 0) {
    customSitemapUrls.forEach((u) => candidateUrls.add(u));
  } else {
    candidateUrls.add(`${parsedOrigin.protocol}//${parsedOrigin.host}/sitemap.xml`);
    candidateUrls.add(`${parsedOrigin.protocol}//${parsedOrigin.host}/sitemap_index.xml`);
  }

  const discoveredUrls: string[] = [];
  const sitemapIndexUrls: string[] = [];
  const errors: string[] = [];
  let foundAny = false;
  let lastStatusCode = 0;

  for (const sitemapUrl of candidateUrls) {
    const fetchRes = await fetchUrl(sitemapUrl, { timeoutMs: 6000 });
    lastStatusCode = fetchRes.statusCode;

    if (fetchRes.statusCode !== 200 || !fetchRes.body) {
      continue;
    }

    foundAny = true;
    const xml = fetchRes.body;

    // Check if it's a sitemap index or standard urlset
    const locMatches = xml.match(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi) || [];

    for (const match of locMatches) {
      const cleanLoc = match.replace(/<\/?loc>/gi, "").trim();
      if (cleanLoc.endsWith(".xml") || xml.includes("<sitemap>")) {
        sitemapIndexUrls.push(cleanLoc);
      } else {
        discoveredUrls.push(cleanLoc);
      }
    }
  }

  // Follow sub-sitemaps from sitemap index (up to 3 child sitemaps to stay lightweight)
  for (const childSitemap of sitemapIndexUrls.slice(0, 3)) {
    const fetchRes = await fetchUrl(childSitemap, { timeoutMs: 5000 });
    if (fetchRes.statusCode === 200 && fetchRes.body) {
      const locMatches = fetchRes.body.match(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi) || [];
      for (const match of locMatches) {
        const cleanLoc = match.replace(/<\/?loc>/gi, "").trim();
        if (!cleanLoc.endsWith(".xml")) {
          discoveredUrls.push(cleanLoc);
        }
      }
    } else {
      // Do not persist an arbitrary sitemap URL in crawl findings. A target can
      // supply credentials in a child location even though the fetcher blocks it.
      errors.push(`A child sitemap returned status ${fetchRes.statusCode}`);
    }
  }

  return {
    exists: foundAny,
    accessible: foundAny,
    statusCode: lastStatusCode,
    urls: Array.from(new Set(discoveredUrls)),
    sitemapIndexUrls: Array.from(new Set(sitemapIndexUrls)),
    errors,
  };
}
