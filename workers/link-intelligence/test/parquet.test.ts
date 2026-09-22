import { describe, expect, it } from "vitest";
import { asyncBufferFromFile } from "hyparquet";
import { readDomainRows, readDomainSummary } from "../src/parquet.js";
import { toNumber } from "../src/numbers.js";
import type { Anchor, DomainSummary, ReferringDomain, TopPage } from "../src/types.js";

const fixture = (name: string) => `test/fixtures/${name}_0000.parquet`;

describe("readDomainSummary", () => {
  it("returns the summary row for an indexed domain", async () => {
    const file = await asyncBufferFromFile(fixture("domain_summary"));
    const summary = await readDomainSummary<DomainSummary>(file, "google.ml", (row) => ({
      target_domain: String(row.target_domain),
      inbound_link_count: toNumber(row.inbound_link_count),
      referring_domain_count: toNumber(row.referring_domain_count),
      domain_rating: null,
    }));

    expect(summary).not.toBeNull();
    expect(summary!.target_domain).toBe("google.ml");
    expect(summary!.inbound_link_count).toBeGreaterThan(0);
    expect(summary!.referring_domain_count).toBeGreaterThan(0);
    expect(summary!.domain_rating).toBeNull();
  });

  it("returns null for an unknown domain", async () => {
    const file = await asyncBufferFromFile(fixture("domain_summary"));
    const summary = await readDomainSummary<DomainSummary>(file, "this-domain-does-not-exist.invalid", (row) => ({
      target_domain: String(row.target_domain),
      inbound_link_count: toNumber(row.inbound_link_count),
      referring_domain_count: toNumber(row.referring_domain_count),
      domain_rating: null,
    }));
    expect(summary).toBeNull();
  });
});

describe("readDomainRows", () => {
  it("returns top anchors ordered by inbound_link_count", async () => {
    const file = await asyncBufferFromFile(fixture("anchors"));
    const { rows, total } = await readDomainRows<Anchor>({
      file,
      columns: ["anchor", "inbound_link_count"],
      domain: "google.ml",
      scoreColumn: "inbound_link_count",
      limit: 5,
      offset: 0,
      build: (row) => ({
        anchor: String(row.anchor),
        inbound_link_count: toNumber(row.inbound_link_count),
      }),
    });

    expect(rows.length).toBe(5);
    expect(total).toBeGreaterThan(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].inbound_link_count).toBeGreaterThanOrEqual(rows[i].inbound_link_count);
    }
  });

  it("supports offset pagination", async () => {
    const file = await asyncBufferFromFile(fixture("referring_domains"));
    const first = await readDomainRows<ReferringDomain>({
      file,
      columns: ["source_domain", "inbound_link_count"],
      domain: "google.ml",
      scoreColumn: "inbound_link_count",
      limit: 3,
      offset: 0,
      build: (row) => ({
        source_domain: String(row.source_domain),
        inbound_link_count: toNumber(row.inbound_link_count),
      }),
    });

    const second = await readDomainRows<ReferringDomain>({
      file,
      columns: ["source_domain", "inbound_link_count"],
      domain: "google.ml",
      scoreColumn: "inbound_link_count",
      limit: 3,
      offset: 3,
      build: (row) => ({
        source_domain: String(row.source_domain),
        inbound_link_count: toNumber(row.inbound_link_count),
      }),
    });

    expect(first.rows.length).toBe(3);
    expect(second.rows.length).toBe(3);
    expect(first.rows[2].source_domain).not.toBe(second.rows[0].source_domain);
  });

  it("reads top_pages with referring_domain_count", async () => {
    const file = await asyncBufferFromFile(fixture("top_pages"));
    const { rows } = await readDomainRows<TopPage>({
      file,
      columns: ["target_url", "inbound_link_count", "referring_domain_count"],
      domain: "google.ml",
      scoreColumn: "inbound_link_count",
      limit: 3,
      offset: 0,
      build: (row) => ({
        target_url: String(row.target_url),
        inbound_link_count: toNumber(row.inbound_link_count),
        referring_domain_count: toNumber(row.referring_domain_count),
      }),
    });

    expect(rows.length).toBe(3);
    expect(rows[0].target_url).toMatch(/^https?:\/\//);
  });
});
