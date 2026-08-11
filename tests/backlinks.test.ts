import assert from "node:assert/strict";
import test from "node:test";
import {
  BacklinkAnalyticsError,
  backlinkTargetFilter,
  normalizeBacklinkDomain,
  normalizeBacklinkPagination,
} from "../lib/backlinks/service";

test("backlink domain normalization accepts common domain input forms", () => {
  for (const input of ["github.com", "https://github.com", "www.github.com", "github.com/"]) {
    assert.equal(normalizeBacklinkDomain(input), "github.com");
  }
  assert.equal(normalizeBacklinkDomain("HTTPS://WWW.Example.CO.UK/path?q=1"), "example.co.uk");
});

test("backlink domain normalization rejects unsafe or malformed input", () => {
  for (const input of ["", "localhost", "github.com:443", "https://user@example.com", "not a domain", "https://github.com:443"]) {
    assert.throws(
      () => normalizeBacklinkDomain(input),
      (error: unknown) => error instanceof BacklinkAnalyticsError && error.code === "INVALID_DOMAIN"
    );
  }
});

test("backlink pagination and target filtering are bounded and use exact target-host lookup", () => {
  assert.deepEqual(normalizeBacklinkPagination({}), { page: 1, pageSize: 10 });
  assert.deepEqual(normalizeBacklinkPagination({ page: -4, pageSize: 0 }), { page: 1, pageSize: 1 });
  assert.deepEqual(normalizeBacklinkPagination({ page: 999, pageSize: 999 }), { page: 100, pageSize: 10 });
  assert.deepEqual(backlinkTargetFilter("github.com"), {
    crawl: "CC-MAIN-2026-30",
    target_host: "github.com",
  });
});
