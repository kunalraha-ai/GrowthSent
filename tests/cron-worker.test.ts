import assert from "node:assert/strict";
import test from "node:test";
import { handleApiRequest } from "../lib/api/router";
import { handleDurableCrawlCronRequest } from "../lib/jobs/cron-worker";

test("internal audit worker route rejects unauthenticated public requests", async () => {
  const response = await handleApiRequest({
    method: "GET",
    path: "/api/v1/internal/audit-worker",
    query: {},
    body: null,
    headers: {},
    ip: "cron-worker-route-test",
  });

  assert.equal(response.statusCode, 401);
});

test("durable crawl cron rejects unauthorized invocations without running work", async () => {
  let invoked = 0;
  const response = await handleDurableCrawlCronRequest(
    { method: "GET", authorization: "Bearer incorrect" },
    {
      cronSecret: "test-cron-secret",
      processWork: async () => {
        invoked += 1;
        return { auditClaimed: false, scanClaimed: false };
      },
    }
  );

  assert.equal(response.statusCode, 401);
  assert.equal(invoked, 0);
});

test("durable crawl cron authorizes Vercel Cron and invokes bounded work exactly once", async () => {
  let invoked = 0;
  const response = await handleDurableCrawlCronRequest(
    { method: "GET", authorization: "Bearer test-cron-secret" },
    {
      cronSecret: "test-cron-secret",
      processWork: async () => {
        invoked += 1;
        return { auditClaimed: true, scanClaimed: false };
      },
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(invoked, 1);
  assert.deepEqual(response.body, { ok: true, auditClaimed: true, scanClaimed: false });
});

test("durable crawl cron only permits GET", async () => {
  const response = await handleDurableCrawlCronRequest(
    { method: "POST", authorization: "Bearer test-cron-secret" },
    { cronSecret: "test-cron-secret" }
  );

  assert.equal(response.statusCode, 405);
});
