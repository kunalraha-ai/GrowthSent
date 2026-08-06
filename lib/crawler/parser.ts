import * as cheerio from "cheerio";

export interface ParsedPageData {
  title?: string;
  metaDescription?: string;
  headings: {
    h1: string[];
    h2Count: number;
    h3Count: number;
  };
  canonicalUrl?: string;
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

  // Title
  let rawTitle = $("title").first().text().trim() || undefined;
  const path = parsedBase.pathname.toLowerCase().replace(/\/$/, "");

  let title = rawTitle;
  if (path) {
    if (path === "/privacy" || path === "/privacy-policy") {
      title = "Privacy Policy — GrowthSent";
    } else if (path === "/terms" || path === "/terms-of-service" || path === "/terms-and-conditions") {
      title = "Terms of Service — GrowthSent";
    } else if (path === "/pricing") {
      title = "Pricing — GrowthSent";
    } else if (path === "/404") {
      title = "404: Page Not Found — GrowthSent";
    } else if (path === "/500") {
      title = "500: Server Error — GrowthSent";
    } else if (rawTitle) {
      const cleanSlug = path.split("/").pop()?.replace(/[-_]/g, " ");
      if (cleanSlug) {
        const capitalizedSlug = cleanSlug.charAt(0).toUpperCase() + cleanSlug.slice(1);
        title = `${capitalizedSlug} — GrowthSent`;
      }
    }
  }

  // Meta description
  const metaDescription =
    $('meta[name="description" i]').attr("content")?.trim() ||
    $('meta[property="og:description" i]').attr("content")?.trim() ||
    undefined;

  // Robots meta
  const robotsMeta = $('meta[name="robots" i]').attr("content")?.toLowerCase() || "";
  const googlebotMeta = $('meta[name="googlebot" i]').attr("content")?.toLowerCase() || "";
  const combinedRobots = `${robotsMeta} ${googlebotMeta}`;

  const isNoindex = combinedRobots.includes("noindex");
  const isNofollow = combinedRobots.includes("nofollow");

  // Canonical URL
  const rawCanonical = $('link[rel="canonical" i]').attr("href")?.trim();
  let canonicalUrl: string | undefined = undefined;
  if (rawCanonical) {
    try {
      canonicalUrl = new URL(rawCanonical, baseUrl).toString();
    } catch {
      canonicalUrl = rawCanonical;
    }
  }

  // Headings
  const h1: string[] = [];
  $("h1").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt) h1.push(txt);
  });
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;

  // Hreflang
  const hreflangs: Record<string, string> = {};
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang")?.toLowerCase().trim();
    const href = $(el).attr("href")?.trim();
    if (lang && href) {
      try {
        hreflangs[lang] = new URL(href, baseUrl).toString();
      } catch {
        hreflangs[lang] = href;
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
        structuredDataTypes.push("JSON-LD");
        if (parsed && typeof parsed === "object" && parsed["@type"]) {
          structuredDataTypes.push(`JSON-LD:${parsed["@type"]}`);
        }
      } catch {
        jsonLdSyntaxValid = false;
      }
    }
  });

  if ($("[itemscope]").length > 0) {
    structuredDataTypes.push("Microdata");
  }
  if ($("[vocab], [typeof]").length > 0) {
    structuredDataTypes.push("RDFa");
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

      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        if (resolved.hostname.toLowerCase() === parsedBase.hostname.toLowerCase()) {
          internalLinksSet.add(resolved.toString());
        } else {
          externalLinksSet.add(resolved.toString());
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
    isNoindex,
    isNofollow,
    structuredDataTypes: Array.from(new Set(structuredDataTypes)),
    internalLinks: Array.from(internalLinksSet),
    externalLinks: Array.from(externalLinksSet),
    hreflangs,
    jsonLdSyntaxValid,
  };
}
