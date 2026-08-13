import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SearchIntelligenceOverviewDashboard,
  type SearchIntelligenceReport,
} from "../src/components/dashboard/SearchPerformanceView";

const emptyOverviewReport: SearchIntelligenceReport = {
  siteUrl: "sc-domain:example.com",
  fetchedAt: "2026-08-13T00:00:00.000Z",
  periods: {
    current: { startDate: "2026-07-12", endDate: "2026-08-08", days: 28 },
    previous: { startDate: "2026-06-14", endDate: "2026-07-11", days: 28 },
  },
  overview: {
    current: { clicks: 4, impressions: 48, ctr: 4 / 48, position: 8 },
    previous: { clicks: 3, impressions: 42, ctr: 3 / 42, position: 9 },
    change: { clicks: 1, impressions: 6, ctr: 4 / 48 - 3 / 42, position: -1 },
  },
  availability: { overview: true, previousOverview: true, trend: true },
  dailySeries: [
    { date: "2026-08-07", clicks: 1, impressions: 20, ctr: 0.05, position: 8 },
    { date: "2026-08-08", clicks: 3, impressions: 28, ctr: 3 / 28, position: 8 },
  ],
  quickWins: [],
  contentDecay: [],
  ctrOpportunities: [],
  potentialCannibalization: [],
  winners: [],
  losers: [],
  keywords: [],
  pages: [],
  reportedRowLimits: { queries: 250, pages: 250, queryPageCombinations: 500 },
};

test("Search Intelligence overview renders all analysis cards for completed zero-result analyses", () => {
  const html = renderToStaticMarkup(
    React.createElement(SearchIntelligenceOverviewDashboard, {
      report: emptyOverviewReport,
      onOpenTab: () => undefined,
    })
  );

  assert.match(html, /Search trend/);
  assert.match(html, /Quick wins/);
  assert.match(html, /0 opportunities/);
  assert.match(html, /Content decay/);
  assert.match(html, /0 candidates/);
  assert.match(html, /CTR opportunities/);
  assert.match(html, /Potential cannibalization/);
  assert.match(html, /0 queries/);
  assert.match(html, /Top queries/);
  assert.match(html, /Top pages/);
  assert.match(html, /Winners &amp; losers/);
  assert.match(html, /No reported query rows/);
  assert.match(html, /No reported page rows/);
});
