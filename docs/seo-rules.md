# GrowthSent — SEO Analysis Rules & Scoring Model

## Severity Categories
- `critical`: Blockers that prevent search engine indexing or return server errors (-15 points).
- `high`: Major signals impacting organic visibility or CTR (-10 points).
- `medium`: Content structure or performance warnings (-5 points).
- `low`: Minor metadata optimizations (-2 points).
- `info`: Helpful informational signals (0 points).

## Rule Catalog
1. **Crawlability**: `robots-txt-missing`, `sitemap-missing`, `sitemap-url-error`.
2. **Indexability**: `noindex-detected`, `canonical-missing`, `canonical-external`.
3. **Metadata**: `title-missing`, `title-too-long`, `title-too-short`, `meta-desc-missing`, `meta-desc-too-long`, `duplicate-titles`.
4. **Content**: `h1-missing`, `h1-multiple`, `thin-content`.
5. **Links**: `broken-internal-link`.
6. **Performance & Security**: `slow-response-time`, `jsonld-syntax-error`.

## Deterministic Scoring Formula
Score is calculated deterministically:
$$\text{Score} = \max\left(0, \min\left(100, 100 - \frac{\sum \text{Deduction Points}}{\sqrt{\text{Total Pages Crawled}}}\right)\right)$$
This formula ensures the health score remains transparent, accurate, and recalculable when rule sets evolve.
