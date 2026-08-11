import { CrawlExecutionResult } from "../crawler/crawler.js";
import { IssueDocument, Severity } from "../db/types.js";
import { SEO_RULES } from "./rules.js";
import { calculateSeoScore, ScoreCalculationResult } from "./scoring.js";

export interface AnalysisExecutionResult {
  issues: Omit<IssueDocument, "_id" | "scanId" | "createdAt">[];
  scoring: ScoreCalculationResult;
}

export function analyzeCrawlResults(crawl: CrawlExecutionResult): AnalysisExecutionResult {
  const issues: Omit<IssueDocument, "_id" | "scanId" | "createdAt">[] = [];
  const supportsSiteDiscovery = crawl.capabilities?.supportsSiteDiscovery !== false;
  const supportsResponseTiming = crawl.capabilities?.supportsResponseTiming !== false;

  // Site-wide checks
  if (supportsSiteDiscovery && !crawl.robots.exists) {
    const rule = SEO_RULES["robots-txt-missing"];
    issues.push({
      ruleId: rule.ruleId,
      category: rule.category,
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      explanation: rule.explanation,
      affectedUrl: `${crawl.startUrl}/robots.txt`,
      recommendation: rule.recommendation,
    });
  }

  if (supportsSiteDiscovery && !crawl.sitemap.exists) {
    const rule = SEO_RULES["sitemap-missing"];
    issues.push({
      ruleId: rule.ruleId,
      category: rule.category,
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      explanation: rule.explanation,
      affectedUrl: `${crawl.startUrl}/sitemap.xml`,
      recommendation: rule.recommendation,
    });
  }

  if (supportsSiteDiscovery && crawl.sitemap.errors.length > 0) {
    const rule = SEO_RULES["sitemap-url-error"];
    issues.push({
      ruleId: rule.ruleId,
      category: rule.category,
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      explanation: rule.explanation,
      affectedUrl: `${crawl.startUrl}/sitemap.xml`,
      evidence: crawl.sitemap.errors.join("; "),
      recommendation: rule.recommendation,
    });
  }

  // Duplicate titles map
  const titleToUrls = new Map<string, string[]>();

  // Page-by-page checks
  for (const page of crawl.pages) {
    if (page.parsedData?.title) {
      const existing = titleToUrls.get(page.parsedData.title) || [];
      existing.push(page.url);
      titleToUrls.set(page.parsedData.title, existing);
    }

    if (page.statusCode !== 200 && page.statusCode !== 0) {
      if (page.statusCode === 404 || page.statusCode >= 500) {
        const rule = SEO_RULES["broken-internal-link"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: `Page returned HTTP status code ${page.statusCode}.`,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      }
    }

    if (supportsResponseTiming && page.responseTimeMs > 1500) {
      const rule = SEO_RULES["slow-response-time"];
      issues.push({
        ruleId: rule.ruleId,
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        description: `Page took ${page.responseTimeMs}ms to respond.`,
        explanation: rule.explanation,
        affectedUrl: page.url,
        evidence: `${page.responseTimeMs}ms`,
        recommendation: rule.recommendation,
      });
    }

    if (page.parsedData) {
      const data = page.parsedData;

      if (data.isNoindex) {
        const rule = SEO_RULES["noindex-detected"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      }

      if (data.canonicalError) {
        const rule = SEO_RULES["canonical-invalid"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: data.canonicalError,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      } else if (!data.canonicalUrl) {
        const rule = SEO_RULES["canonical-missing"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      } else {
        try {
          const canonical = new URL(data.canonicalUrl);
          if (canonical.protocol !== "http:" && canonical.protocol !== "https:") {
            throw new Error("Canonical URL must use HTTP or HTTPS.");
          }

          if (canonical.hostname.toLowerCase() !== crawl.hostname) {
            const rule = SEO_RULES["canonical-external"];
            issues.push({
              ruleId: rule.ruleId,
              category: rule.category,
              severity: rule.severity,
              title: rule.title,
              description: `Canonical URL points to an external domain: ${data.canonicalUrl}`,
              explanation: rule.explanation,
              affectedUrl: page.url,
              evidence: data.canonicalUrl,
              recommendation: rule.recommendation,
            });
          }
        } catch {
          const rule = SEO_RULES["canonical-invalid"];
          issues.push({
            ruleId: rule.ruleId,
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            description: "Canonical URL is malformed or uses an unsupported protocol.",
            explanation: rule.explanation,
            affectedUrl: page.url,
            evidence: data.canonicalUrl,
            recommendation: rule.recommendation,
          });
        }
      }

      if (!data.title) {
        const rule = SEO_RULES["title-missing"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      } else {
        if (data.title.length > 60) {
          const rule = SEO_RULES["title-too-long"];
          issues.push({
            ruleId: rule.ruleId,
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            description: `Title tag is ${data.title.length} characters long.`,
            explanation: rule.explanation,
            affectedUrl: page.url,
            evidence: data.title,
            recommendation: rule.recommendation,
          });
        } else if (data.title.length < 10) {
          const rule = SEO_RULES["title-too-short"];
          issues.push({
            ruleId: rule.ruleId,
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            description: `Title tag is only ${data.title.length} characters long.`,
            explanation: rule.explanation,
            affectedUrl: page.url,
            evidence: data.title,
            recommendation: rule.recommendation,
          });
        }
      }

      if (!data.metaDescription) {
        const rule = SEO_RULES["meta-desc-missing"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      } else if (data.metaDescription.length > 160) {
        const rule = SEO_RULES["meta-desc-too-long"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: `Meta description is ${data.metaDescription.length} characters long.`,
          explanation: rule.explanation,
          affectedUrl: page.url,
          evidence: data.metaDescription,
          recommendation: rule.recommendation,
        });
      }

      if (data.headings.h1.length === 0) {
        const rule = SEO_RULES["h1-missing"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      } else if (data.headings.h1.length > 1) {
        const rule = SEO_RULES["h1-multiple"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: `Page contains ${data.headings.h1.length} H1 tags.`,
          explanation: rule.explanation,
          affectedUrl: page.url,
          evidence: data.headings.h1.join("; "),
          recommendation: rule.recommendation,
        });
      }

      if (!data.jsonLdSyntaxValid) {
        const rule = SEO_RULES["jsonld-syntax-error"];
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          explanation: rule.explanation,
          affectedUrl: page.url,
          recommendation: rule.recommendation,
        });
      }
    }
  }

  // Duplicate title checks across pages
  for (const [titleText, urls] of titleToUrls.entries()) {
    if (urls.length > 1) {
      const rule = SEO_RULES["duplicate-titles"];
      for (const affectedUrl of urls) {
        issues.push({
          ruleId: rule.ruleId,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: `Shares title "${titleText}" with ${urls.length - 1} other page(s).`,
          explanation: rule.explanation,
          affectedUrl,
          evidence: titleText,
          recommendation: rule.recommendation,
        });
      }
    }
  }

  const scoring = calculateSeoScore(issues, crawl.totalPagesCrawled);

  return {
    issues,
    scoring,
  };
}
