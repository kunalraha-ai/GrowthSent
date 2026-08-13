import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchIntelligenceReport } from "../lib/integrations/search-intelligence";

const metrics = (clicks: number, impressions: number, position = 8) => ({
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

const daily = (date: string, clicks: number, impressions: number, position = 8) => ({
  date,
  ...metrics(clicks, impressions, position),
});

test("Search Intelligence derives only bounded, real GSC metric comparisons", () => {
  const report = buildSearchIntelligenceReport({
    siteUrl: "sc-domain:example.com",
    currentPeriod: { startDate: "2026-07-12", endDate: "2026-08-08", days: 28 },
    previousPeriod: { startDate: "2026-06-14", endDate: "2026-07-11", days: 28 },
    currentDaily: [daily("2026-08-07", 60, 600, 6), daily("2026-08-08", 40, 400, 8)],
    previousDaily: [daily("2026-07-10", 45, 500, 7), daily("2026-07-11", 35, 300, 9)],
    currentQueries: [
      { query: "fast widgets", ...metrics(4, 220, 7) },
      { query: "winner query", ...metrics(25, 150, 4) },
      { query: "newly reported query", ...metrics(2, 40, 10) },
    ],
    previousQueries: [
      { query: "fast widgets", ...metrics(20, 200, 7) },
      { query: "winner query", ...metrics(5, 100, 4) },
    ],
    currentPages: [
      { page: "https://example.com/decaying", ...metrics(3, 180, 9) },
      { page: "https://example.com/growing", ...metrics(30, 200, 5) },
    ],
    previousPages: [
      { page: "https://example.com/decaying", ...metrics(13, 210, 8) },
      { page: "https://example.com/growing", ...metrics(5, 120, 6) },
    ],
    currentQueryPages: [
      { query: "fast widgets", page: "https://example.com/widgets", ...metrics(6, 120, 7) },
      { query: "fast widgets", page: "https://example.com/widgets-guide", ...metrics(4, 100, 7) },
    ],
    reportedRowLimits: { queries: 250, pages: 250, queryPageCombinations: 500 },
  });

  assert.deepEqual(report.overview.current, metrics(100, 1000, 6.8));
  assert.equal(report.overview.change.clicks, 20);
  assert.equal(report.availability.overview, true);
  assert.equal(report.availability.previousOverview, true);
  assert.equal(report.availability.trend, true);
  assert.deepEqual(report.dailySeries.map((row) => row.date), ["2026-08-07", "2026-08-08"]);
  assert.equal(report.quickWins[0]?.query, "fast widgets");
  assert.equal(report.ctrOpportunities[0]?.query, "fast widgets");
  assert.equal(report.contentDecay[0]?.page, "https://example.com/decaying");
  assert.equal(report.potentialCannibalization[0]?.query, "fast widgets");
  assert.equal(report.potentialCannibalization[0]?.pageCount, 2);
  assert.equal(report.winners[0]?.label, "https://example.com/growing");
  assert.equal(report.losers[0]?.label, "fast widgets");
  assert.equal(report.keywords.find((row) => row.query === "newly reported query")?.previous, null);
  assert.equal(report.keywords.find((row) => row.query === "newly reported query")?.change, null);
});

test("Search Intelligence does not turn missing prior GSC rows into zero-valued comparisons", () => {
  const report = buildSearchIntelligenceReport({
    siteUrl: "sc-domain:example.com",
    currentPeriod: { startDate: "2026-07-12", endDate: "2026-08-08", days: 28 },
    previousPeriod: { startDate: "2026-06-14", endDate: "2026-07-11", days: 28 },
    currentDaily: [daily("2026-08-08", 1, 10)],
    previousDaily: [],
    currentQueries: [{ query: "reported now", ...metrics(1, 10) }],
    previousQueries: [],
    currentPages: [],
    previousPages: [],
    currentQueryPages: [],
    reportedRowLimits: { queries: 250, pages: 250, queryPageCombinations: 500 },
  });

  assert.equal(report.keywords[0]?.previous, null);
  assert.equal(report.keywords[0]?.change, null);
  assert.equal(report.winners.length, 0);
  assert.equal(report.losers.length, 0);
  assert.equal(report.availability.trend, false);
});

test("Search Intelligence marks overview metrics unavailable when GSC returns no date rows", () => {
  const report = buildSearchIntelligenceReport({
    siteUrl: "sc-domain:example.com",
    currentPeriod: { startDate: "2026-07-12", endDate: "2026-08-08", days: 28 },
    previousPeriod: { startDate: "2026-06-14", endDate: "2026-07-11", days: 28 },
    currentDaily: [],
    previousDaily: [],
    currentQueries: [],
    previousQueries: [],
    currentPages: [],
    previousPages: [],
    currentQueryPages: [],
    reportedRowLimits: { queries: 250, pages: 250, queryPageCombinations: 500 },
  });

  assert.equal(report.availability.overview, false);
  assert.equal(report.availability.previousOverview, false);
  assert.equal(report.availability.trend, false);
  assert.deepEqual(report.dailySeries, []);
});
