import assert from "node:assert";
import { parsePageHtml } from "../lib/crawler/parser";
import { isPathDisallowedByRobots } from "../lib/crawler/robots";

function testCrawlerComponents() {
  console.log("Running Crawler Component Tests...");

  // Test HTML parser
  const sampleHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>GrowthSent — Developer-First SEO</title>
      <meta name="description" content="The simplest way for indie hackers to understand website SEO." />
      <link rel="canonical" href="https://growthsent.com/" />
      <meta name="robots" content="index, follow" />
      <script type="application/ld+json">
        { "@context": "https://schema.org", "@type": "SoftwareApplication", "name": "GrowthSent" }
      </script>
    </head>
    <body>
      <h1>SEO Shouldn't Be Hard</h1>
      <a href="/pricing">Pricing Page</a>
      <a href="https://external.com">External Link</a>
    </body>
    </html>
  `;

  const parsed = parsePageHtml(sampleHtml, "https://growthsent.com/");

  assert.strictEqual(parsed.title, "GrowthSent — Developer-First SEO");
  assert.strictEqual(parsed.metaDescription, "The simplest way for indie hackers to understand website SEO.");
  assert.strictEqual(parsed.canonicalUrl, "https://growthsent.com/");
  assert.strictEqual(parsed.isNoindex, false);
  assert.strictEqual(parsed.headings.h1.length, 1);
  assert.strictEqual(parsed.headings.h1[0], "SEO Shouldn't Be Hard");
  assert.ok(parsed.structuredDataTypes.includes("JSON-LD"));
  assert.ok(parsed.internalLinks.includes("https://growthsent.com/pricing"));
  assert.ok(parsed.externalLinks.includes("https://external.com/"));

  // Test robots path matching
  const disallowed = ["/admin", "/private/", "/checkout"];
  const allowed = ["/admin/public"];

  assert.strictEqual(isPathDisallowedByRobots("/admin/settings", disallowed, allowed), true);
  assert.strictEqual(isPathDisallowedByRobots("/admin/public", disallowed, allowed), false);
  assert.strictEqual(isPathDisallowedByRobots("/blog/post-1", disallowed, allowed), false);

  console.log("✔ Crawler Component Tests Passed!");
}

testCrawlerComponents();
