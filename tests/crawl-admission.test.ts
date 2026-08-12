import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_MVP_CRAWL_ADMISSION,
  createAnonymousAdmissionActorKey,
  createCrawlAdmissionTargetKey,
  isActiveCrawlStatus,
} from "../lib/jobs/crawl-admission.js";

test("persistent audit-admission identifiers are privacy-preserving and domain-scoped", () => {
  const key = createAnonymousAdmissionActorKey("203.0.113.42");
  assert.match(key, /^anonymous:[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /203\.0\.113\.42/);
  assert.equal(createCrawlAdmissionTargetKey("https://www.example.co.uk/path"), "example.co.uk");
});

test("external-MVP admission policy has intentionally low bounded limits", () => {
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.authenticatedPerHour, 8);
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.anonymousPerHour, 2);
  assert.equal(EXTERNAL_MVP_CRAWL_ADMISSION.queueCap, 25);
  assert.equal(isActiveCrawlStatus("queued"), true);
  assert.equal(isActiveCrawlStatus("completed"), false);
});
