import { IssueCategory, Severity } from "../db/types.js";

export interface SEORuleDefinition {
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  title: string;
  description: string;
  explanation: string;
  recommendation: string;
}

export const SEO_RULES: Record<string, SEORuleDefinition> = {
  // Crawlability
  "robots-txt-missing": {
    ruleId: "robots-txt-missing",
    category: "crawlability",
    severity: "medium",
    title: "robots.txt File Missing",
    description: "No robots.txt file was detected at /robots.txt.",
    explanation: "A robots.txt file provides crawling guidelines to web crawlers and specifies sitemap locations.",
    recommendation: "Create a robots.txt file in your website root directory outlining crawl rules and linking your sitemap.xml.",
  },
  "sitemap-missing": {
    ruleId: "sitemap-missing",
    category: "crawlability",
    severity: "high",
    title: "XML Sitemap Missing",
    description: "No valid XML sitemap was found at /sitemap.xml or in robots.txt.",
    explanation: "Sitemaps help search engine crawlers discover all important pages on your website reliably.",
    recommendation: "Generate and submit a sitemap.xml file listing all indexable public pages.",
  },
  "sitemap-url-error": {
    ruleId: "sitemap-url-error",
    category: "crawlability",
    severity: "high",
    title: "Sitemap Contains Broken URLs",
    description: "One or more URLs listed in your sitemap returned an error status.",
    explanation: "Listing broken or redirecting URLs in your sitemap wastes crawler budget.",
    recommendation: "Audit your sitemap.xml and remove non-200 OK URLs.",
  },

  // Indexability
  "noindex-detected": {
    ruleId: "noindex-detected",
    category: "indexability",
    severity: "critical",
    title: "Page Blocked from Indexing (noindex)",
    description: "Page contains a 'noindex' meta tag or HTTP header.",
    explanation: "The noindex directive instructs search engines not to include this page in search results.",
    recommendation: "If this page should appear in search results, remove the noindex meta tag.",
  },
  "canonical-missing": {
    ruleId: "canonical-missing",
    category: "indexability",
    severity: "medium",
    title: "Canonical Tag Missing",
    description: "Page does not specify a rel='canonical' link tag.",
    explanation: "Canonical tags prevent duplicate content issues by specifying the preferred URL version.",
    recommendation: "Add a <link rel='canonical' href='...' /> tag pointing to the authoritative version of this page.",
  },
  "canonical-external": {
    ruleId: "canonical-external",
    category: "indexability",
    severity: "high",
    title: "Canonical URL Points Elsewhere",
    description: "Page canonical tag points to a different URL.",
    explanation: "This tells search engines to index a different target page instead of this page.",
    recommendation: "Ensure canonical tags accurately reflect the intended canonical URL for this page.",
  },

  // Metadata
  "title-missing": {
    ruleId: "title-missing",
    category: "metadata",
    severity: "critical",
    title: "Missing Page Title Tag",
    description: "Page has no <title> tag.",
    explanation: "Title tags are one of the most critical search ranking and user CTR signals.",
    recommendation: "Add a unique, descriptive <title> tag between 30 and 60 characters.",
  },
  "title-too-long": {
    ruleId: "title-too-long",
    category: "metadata",
    severity: "low",
    title: "Title Tag Too Long",
    description: "Title exceeds 60 characters and may be truncated in search results.",
    explanation: "Search engines truncate long titles, which can hurt click-through rates.",
    recommendation: "Shorten the title tag to under 60 characters.",
  },
  "title-too-short": {
    ruleId: "title-too-short",
    category: "metadata",
    severity: "low",
    title: "Title Tag Too Short",
    description: "Title is shorter than 10 characters.",
    explanation: "Short titles miss the opportunity to include key brand and topic keywords.",
    recommendation: "Expand the title tag to be more descriptive (30-60 characters).",
  },
  "meta-desc-missing": {
    ruleId: "meta-desc-missing",
    category: "metadata",
    severity: "high",
    title: "Missing Meta Description",
    description: "Page lacks a meta description tag.",
    explanation: "Meta descriptions appear as search result snippets and directly influence click-through rates.",
    recommendation: "Add a compelling <meta name='description' content='...'> tag between 120 and 160 characters.",
  },
  "meta-desc-too-long": {
    ruleId: "meta-desc-too-long",
    category: "metadata",
    severity: "low",
    title: "Meta Description Too Long",
    description: "Meta description exceeds 160 characters.",
    explanation: "Snippets longer than 160 characters are truncated on search result pages.",
    recommendation: "Trim the meta description to under 160 characters.",
  },
  "duplicate-titles": {
    ruleId: "duplicate-titles",
    category: "metadata",
    severity: "high",
    title: "Duplicate Page Title",
    description: "Multiple pages share the exact same title tag.",
    explanation: "Duplicate titles make it difficult for search engines to differentiate unique page content.",
    recommendation: "Ensure every page on your site has a distinct, unique title.",
  },

  // Content
  "h1-missing": {
    ruleId: "h1-missing",
    category: "content",
    severity: "high",
    title: "Missing H1 Heading",
    description: "Page has no <h1> heading tag.",
    explanation: "H1 headings communicate the main topic of the page to search engine crawlers and users.",
    recommendation: "Add exactly one descriptive <h1> heading to the page.",
  },
  "h1-multiple": {
    ruleId: "h1-multiple",
    category: "content",
    severity: "medium",
    title: "Multiple H1 Headings",
    description: "Page contains more than one <h1> heading.",
    explanation: "Having multiple H1 headings can dilute the primary topic signal of the page.",
    recommendation: "Use a single <h1> heading per page and organize sub-sections with <h2> and <h3> tags.",
  },
  "thin-content": {
    ruleId: "thin-content",
    category: "content",
    severity: "medium",
    title: "Thin Page Content",
    description: "Page contains very little text content.",
    explanation: "Pages with very sparse text content may provide insufficient value for search indexers.",
    recommendation: "Enrich the page with helpful, relevant content and detailed explanations.",
  },

  // Links
  "broken-internal-link": {
    ruleId: "broken-internal-link",
    category: "links",
    severity: "critical",
    title: "Broken Internal Link (404/Error)",
    description: "Page links to an internal URL that returns an HTTP error code.",
    explanation: "Broken links create dead ends for visitors and waste crawler budget.",
    recommendation: "Fix or remove links pointing to non-existent internal URLs.",
  },
  "slow-response-time": {
    ruleId: "slow-response-time",
    category: "performance",
    severity: "medium",
    title: "Slow Server Response Time",
    description: "Server response time exceeded 1,500ms.",
    explanation: "Slow server response speeds degrade user experience and crawling efficiency.",
    recommendation: "Optimize server database queries, enable edge caching, or compress static assets.",
  },
  "jsonld-syntax-error": {
    ruleId: "jsonld-syntax-error",
    category: "structured-data",
    severity: "high",
    title: "Invalid JSON-LD Structured Data",
    description: "Page contains a script block with malformed JSON-LD syntax.",
    explanation: "Search engines cannot parse structured data blocks with syntax errors.",
    recommendation: "Validate and format your JSON-LD code using valid JSON syntax.",
  },
};
