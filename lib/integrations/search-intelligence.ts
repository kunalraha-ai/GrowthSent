export interface GscMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryRow extends GscMetrics {
  query: string;
}

export interface GscPageRow extends GscMetrics {
  page: string;
}

export interface GscQueryPageRow extends GscMetrics {
  query: string;
  page: string;
}

export interface GscDailyRow extends GscMetrics {
  date: string;
}

export type GscComparisonRow<T extends GscMetrics> = T & {
  previous: GscMetrics | null;
  change: GscMetrics | null;
};

export interface SearchIntelligenceReport {
  siteUrl: string;
  fetchedAt: string;
  periods: {
    current: { startDate: string; endDate: string; days: number };
    previous: { startDate: string; endDate: string; days: number };
  };
  overview: {
    current: GscMetrics;
    previous: GscMetrics;
    change: GscMetrics;
  };
  availability: {
    overview: boolean;
    previousOverview: boolean;
    trend: boolean;
  };
  /** Date-level rows returned by GSC for the current period; never manufactured. */
  dailySeries: GscDailyRow[];
  quickWins: Array<GscComparisonRow<GscQueryRow>>;
  contentDecay: Array<GscComparisonRow<GscPageRow>>;
  ctrOpportunities: Array<GscComparisonRow<GscQueryRow>>;
  potentialCannibalization: Array<{
    query: string;
    pageCount: number;
    totalClicks: number;
    totalImpressions: number;
    pages: GscPageRow[];
  }>;
  winners: Array<{ kind: "query" | "page"; label: string; row: GscComparisonRow<GscQueryRow | GscPageRow> }>;
  losers: Array<{ kind: "query" | "page"; label: string; row: GscComparisonRow<GscQueryRow | GscPageRow> }>;
  keywords: Array<GscComparisonRow<GscQueryRow>>;
  pages: Array<GscComparisonRow<GscPageRow>>;
  reportedRowLimits: {
    queries: number;
    pages: number;
    queryPageCombinations: number;
  };
}

export function emptyMetrics(): GscMetrics {
  return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

export function summarizeMetrics(rows: GscMetrics[]): GscMetrics {
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const weightedPosition = rows.reduce((total, row) => total + row.position * row.impressions, 0);

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  };
}

function metricChange(current: GscMetrics, previous: GscMetrics): GscMetrics {
  return {
    clicks: current.clicks - previous.clicks,
    impressions: current.impressions - previous.impressions,
    ctr: current.ctr - previous.ctr,
    position: current.position - previous.position,
  };
}

function comparisonRows<K extends "query" | "page", T extends GscMetrics & Record<K, string>>(
  current: T[],
  previous: T[],
  key: K
): Array<GscComparisonRow<T>> {
  const previousByKey = new Map<string, T>(previous.map((row) => [row[key], row]));

  return current.map((row) => {
    const previousRow = previousByKey.get(row[key]) || null;
    const previousMetrics = previousRow
      ? {
          clicks: previousRow.clicks,
          impressions: previousRow.impressions,
          ctr: previousRow.ctr,
          position: previousRow.position,
        }
      : null;
    const currentMetrics: GscMetrics = {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };

    return {
      ...row,
      previous: previousMetrics,
      change: previousMetrics ? metricChange(currentMetrics, previousMetrics) : null,
    };
  });
}

function topChanges(
  rows: Array<{ kind: "query" | "page"; label: string; row: GscComparisonRow<GscQueryRow | GscPageRow> }>,
  direction: "winner" | "loser"
) {
  return rows
    .filter(({ row }) => row.change !== null)
    .filter(({ row }) => direction === "winner" ? row.change!.clicks > 0 : row.change!.clicks < 0)
    .sort((left, right) => direction === "winner"
      ? right.row.change!.clicks - left.row.change!.clicks
      : left.row.change!.clicks - right.row.change!.clicks)
    .slice(0, 8);
}

export function buildSearchIntelligenceReport(input: {
  siteUrl: string;
  currentPeriod: SearchIntelligenceReport["periods"]["current"];
  previousPeriod: SearchIntelligenceReport["periods"]["previous"];
  currentDaily: GscDailyRow[];
  previousDaily: GscDailyRow[];
  currentQueries: GscQueryRow[];
  previousQueries: GscQueryRow[];
  currentPages: GscPageRow[];
  previousPages: GscPageRow[];
  currentQueryPages: GscQueryPageRow[];
  reportedRowLimits: SearchIntelligenceReport["reportedRowLimits"];
}): SearchIntelligenceReport {
  const overviewCurrent = summarizeMetrics(input.currentDaily);
  const overviewPrevious = summarizeMetrics(input.previousDaily);
  const keywords = comparisonRows(input.currentQueries, input.previousQueries, "query");
  const pages = comparisonRows(input.currentPages, input.previousPages, "page");

  const quickWins = keywords
    .filter((row) => row.impressions >= 50 && row.position >= 4 && row.position <= 20)
    .sort((left, right) => right.impressions - left.impressions)
    .slice(0, 8);

  const ctrOpportunities = keywords
    .filter((row) => row.impressions >= 100 && row.position <= 10 && row.ctr < 0.03)
    .sort((left, right) => right.impressions - left.impressions)
    .slice(0, 8);

  const contentDecay = pages
    .filter((row) => row.previous !== null && row.previous.clicks >= 5 && row.clicks < row.previous.clicks)
    .sort((left, right) => left.change!.clicks - right.change!.clicks)
    .slice(0, 8);

  const pagesByQuery = new Map<string, GscPageRow[]>();
  for (const row of input.currentQueryPages) {
    const values = pagesByQuery.get(row.query) || [];
    values.push({
      page: row.page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
    pagesByQuery.set(row.query, values);
  }

  const potentialCannibalization = [...pagesByQuery.entries()]
    .map(([query, queryPages]) => ({
      query,
      pageCount: queryPages.length,
      totalClicks: queryPages.reduce((total, page) => total + page.clicks, 0),
      totalImpressions: queryPages.reduce((total, page) => total + page.impressions, 0),
      pages: [...queryPages].sort((left, right) => right.impressions - left.impressions).slice(0, 5),
    }))
    .filter((group) => group.pageCount >= 2 && group.totalImpressions >= 20)
    .sort((left, right) => right.totalImpressions - left.totalImpressions)
    .slice(0, 8);

  const changedRows = [
    ...keywords.map((row) => ({ kind: "query" as const, label: row.query, row })),
    ...pages.map((row) => ({ kind: "page" as const, label: row.page, row })),
  ];

  return {
    siteUrl: input.siteUrl,
    fetchedAt: new Date().toISOString(),
    periods: { current: input.currentPeriod, previous: input.previousPeriod },
    overview: {
      current: overviewCurrent,
      previous: overviewPrevious,
      change: metricChange(overviewCurrent, overviewPrevious),
    },
    availability: {
      overview: input.currentDaily.length > 0,
      previousOverview: input.previousDaily.length > 0,
      trend: input.currentDaily.length > 1,
    },
    dailySeries: [...input.currentDaily].sort((left, right) => left.date.localeCompare(right.date)),
    quickWins,
    contentDecay,
    ctrOpportunities,
    potentialCannibalization,
    winners: topChanges(changedRows, "winner"),
    losers: topChanges(changedRows, "loser"),
    keywords,
    pages,
    reportedRowLimits: input.reportedRowLimits,
  };
}
