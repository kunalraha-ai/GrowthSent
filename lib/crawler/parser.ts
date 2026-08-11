import * as cheerio from "cheerio";

const MAX_TITLE_LENGTH = 512;
const MAX_META_DESCRIPTION_LENGTH = 2_048;
const MAX_HEADING_LENGTH = 1_024;
const MAX_H1_HEADINGS = 100;
const MAX_LINKS_PER_PAGE = 2_000;
const MAX_HREFLANGS_PER_PAGE = 100;
const MAX_STRUCTURED_DATA_TYPES = 100;

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function hasUrlCredentials(url: URL): boolean {
  return Boolean(url.username || url.password);
}

export interface ParsedPageData {
  title?: string;
  metaDescription?: string;
  headings: {
    h1: string[];
    h2Count: number;
    h3Count: number;
  };
  canonicalUrl?: string;
  canonicalError?: string;
  isNoindex: boolean;
  isNofollow: boolean;
  structuredDataTypes: string[];
  internalLinks: string[];
  externalLinks: string[];
  hreflangs: Record<string, string>;
  jsonLdSyntaxValid: boolean;
}

export function parsePageHtml(html: string, baseUrl: string): ParsedPageData {
  const $ = cheerio.load(html);
  const parsedBase = new URL(baseUrl);

  // Preserve the title supplied by the crawled page. Generated product-specific
  // titles corrupt customer SEO data and make duplicate-title findings invalid.
  const rawTitle = $("title").first().text().trim();
  const title = rawTitle ? boundedText(rawTitle, MAX_TITLE_LENGTH) : undefined;

  // Meta description
  const rawMetaDescription =
    $('meta[name="description" i]').attr("content")?.trim() ||
    $('meta[property="og:description" i]').attr("content")?.trim() ||
    undefined;
  const metaDescription = rawMetaDescription ? boundedText(rawMetaDescription, MAX_META_DESCRIPTION_LENGTH) : undefined;

  // Robots meta
  const robotsMeta = $('meta[name="robots" i]').attr("content")?.toLowerCase() || "";
  const googlebotMeta = $('meta[name="googlebot" i]').attr("content")?.toLowerCase() || "";
  const combinedRobots = `${robotsMeta} ${googlebotMeta}`;

  const isNoindex = combinedRobots.includes("noindex");
  const isNofollow = combinedRobots.includes("nofollow");

  // Canonical URL
  const rawCanonical = $('link[rel="canonical" i]').attr("href")?.trim();
  let canonicalUrl: string | undefined;
  let canonicalError: string | undefined;
  if (rawCanonical) {
    try {
      const parsedCanonical = new URL(rawCanonical, baseUrl);
      if (parsedCanonical.protocol !== "http:" && parsedCanonical.protocol !== "https:") {
        canonicalError = "Canonical URL must use HTTP or HTTPS.";
      } else if (hasUrlCredentials(parsedCanonical)) {
        canonicalError = "Canonical URL must not contain credentials.";
      } else {
        canonicalUrl = parsedCanonical.toString();
      }
    } catch {
      canonicalError = "Canonical URL is malformed.";
    }
  }

  // Headings
  const h1: string[] = [];
  $("h1").each((_, el) => {
    if (h1.length >= MAX_H1_HEADINGS) return;
    const txt = $(el).text().trim();
    if (txt) h1.push(boundedText(txt, MAX_HEADING_LENGTH));
  });
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;

  // Hreflang
  const hreflangs: Record<string, string> = {};
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    if (Object.keys(hreflangs).length >= MAX_HREFLANGS_PER_PAGE) return;
    const lang = $(el).attr("hreflang")?.toLowerCase().trim();
    const href = $(el).attr("href")?.trim();
    if (lang && href) {
      try {
        const resolved = new URL(href, baseUrl);
        if (!hasUrlCredentials(resolved) && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
          hreflangs[boundedText(lang, 64)] = resolved.toString();
        }
      } catch {
        // Ignore malformed hreflang values rather than persisting raw URLs.
      }
    }
  });

  // Structured Data Detection
  const structuredDataTypes: string[] = [];
  let jsonLdSyntaxValid = true;

  $('script[type="application/ld+json"]').each((_, el) => {
    const rawContent = $(el).html() || "";
    if (rawContent) {
      try {
        const parsed = JSON.parse(rawContent);
        if (structuredDataTypes.length < MAX_STRUCTURED_DATA_TYPES) structuredDataTypes.push("JSON-LD");
        if (parsed && typeof parsed === "object" && parsed["@type"]) {
          if (structuredDataTypes.length < MAX_STRUCTURED_DATA_TYPES) {
            structuredDataTypes.push(`JSON-LD:${boundedText(String(parsed["@type"]), 256)}`);
          }
        }
      } catch {
        jsonLdSyntaxValid = false;
      }
    }
  });

  if ($("[itemscope]").length > 0) {
    if (structuredDataTypes.length < MAX_STRUCTURED_DATA_TYPES) structuredDataTypes.push("Microdata");
  }
  if ($("[vocab], [typeof]").length > 0) {
    if (structuredDataTypes.length < MAX_STRUCTURED_DATA_TYPES) structuredDataTypes.push("RDFa");
  }

  // Links
  const internalLinksSet = new Set<string>();
  const externalLinksSet = new Set<string>();

  $("a[href]").each((_, el) => {
    const rawHref = $(el).attr("href")?.trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) {
      return;
    }

    try {
      const resolved = new URL(rawHref, baseUrl);
      resolved.hash = ""; // Strip anchor

      if (!hasUrlCredentials(resolved) && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
        if (resolved.hostname.toLowerCase() === parsedBase.hostname.toLowerCase()) {
          if (internalLinksSet.size < MAX_LINKS_PER_PAGE) internalLinksSet.add(resolved.toString());
        } else {
          if (externalLinksSet.size < MAX_LINKS_PER_PAGE) externalLinksSet.add(resolved.toString());
        }
      }
    } catch {
      // Invalid URL ignored
    }
  });

  return {
    title,
    metaDescription,
    headings: {
      h1,
      h2Count,
      h3Count,
    },
    canonicalUrl,
    canonicalError,
    isNoindex,
    isNofollow,
    structuredDataTypes: Array.from(new Set(structuredDataTypes)),
    internalLinks: Array.from(internalLinksSet),
    externalLinks: Array.from(externalLinksSet),
    hreflangs,
    jsonLdSyntaxValid,
  };
}
