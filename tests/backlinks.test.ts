import assert from "node:assert/strict";
import test from "node:test";
import {
  BacklinkAnalyticsError,
  backlinkTargetFilter,
  isExternalBacklinkObservation,
  normalizeBacklinkDomain,
  normalizeBacklinkPagination,
} from "../lib/backlinks/service";
import { backlinkSharedCacheKey } from "../lib/backlinks/shared-protection";

test("backlink domain normalization accepts common domain input forms", () => {
  for (const input of ["github.com", "https://github.com", "github.com/"]) {
    assert.equal(normalizeBacklinkDomain(input), "github.com");
  }
  assert.equal(normalizeBacklinkDomain("www.github.com"), "www.github.com");
  assert.equal(normalizeBacklinkDomain("HTTPS://WWW.Example.CO.UK/path?q=1"), "www.example.co.uk");
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

test("backlink observations exclude internal registrable-domain relationships", () => {
  assert.equal(isExternalBacklinkObservation("eignex.com", "eignex.com"), false, "same host is internal");
  assert.equal(isExternalBacklinkObservation("www.example.com", "example.com"), false, "www and apex are internal");
  assert.equal(isExternalBacklinkObservation("docs.example.com", "app.example.com"), false, "sibling subdomains are internal");
  assert.equal(isExternalBacklinkObservation("referrer.net", "example.com"), true, "unrelated registrable domain is external");
  assert.equal(isExternalBacklinkObservation(null, "example.com"), false, "missing referring host is not marketed as external");
});

test("shared backlink cache keys include every result-affecting bounded parameter", () => {
  const base = backlinkSharedCacheKey("github.com", 1, 10);
  assert.notEqual(base, backlinkSharedCacheKey("www.github.com", 1, 10));
  assert.notEqual(base, backlinkSharedCacheKey("github.com", 2, 10));
  assert.notEqual(base, backlinkSharedCacheKey("github.com", 1, 5));
});
