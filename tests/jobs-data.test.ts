import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import {
  DATABASE_INDEX_MANIFEST,
  provisionDatabaseIndexesForDb,
} from "../lib/db/indexes";

test("index manifest contains worker leases and one-time OAuth state TTL coverage", () => {
  const names = new Set(DATABASE_INDEX_MANIFEST.map((definition) => definition.name));
  assert.ok(names.has("scans_queue_due"));
  assert.ok(names.has("scans_lease_expiry"));
  assert.ok(names.has("crawl_jobs_queue_due"));
  assert.ok(names.has("crawl_jobs_lease_expiry"));
  assert.ok(names.has("login_oauth_states_state_unique"));
  assert.ok(names.has("login_oauth_states_expires_at_ttl"));
  assert.ok(names.has("google_oauth_states_state_unique"));
  assert.ok(names.has("google_oauth_states_expires_at_ttl"));
  const googleIdIndex = DATABASE_INDEX_MANIFEST.find((definition) => definition.name === "users_google_id_unique_sparse");
  assert.deepEqual(googleIdIndex?.duplicateAuditMatch, { googleId: { $exists: true } });
});

test("unique index provisioning cannot bypass the duplicate-audit gate", async () => {
  await assert.rejects(
    provisionDatabaseIndexesForDb({} as Db, { includeUnique: true }),
    /requires an explicit duplicate audit/i
  );
});

test("safe index provisioning continues after a failed definition and surfaces all failures", async () => {
  const attempted: string[] = [];
  const fakeDb = {
    collection(collectionName: string) {
      return {
        async createIndex(_key: unknown, options: { name: string }) {
          attempted.push(options.name);
          if (options.name === "scans_queue_due") throw new Error("simulated failure");
          return options.name;
        },
      };
    },
  } as unknown as Db;

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      provisionDatabaseIndexesForDb(fakeDb),
      /scans\.scans_queue_due/i
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(attempted.includes("scans_queue_due"));
  assert.ok(attempted.includes("analytics_events_website_timestamp"));
  assert.equal(attempted.includes("sessions_expires_at_ttl"), false);
});

test("TTL index provisioning requires a separate explicit approval", async () => {
  const attempted: string[] = [];
  const fakeDb = {
    collection() {
      return {
        async createIndex(_key: unknown, options: { name: string }) {
          attempted.push(options.name);
          return options.name;
        },
      };
    },
  } as unknown as Db;

  await provisionDatabaseIndexesForDb(fakeDb, { includeTtl: true });
  assert.ok(attempted.includes("sessions_expires_at_ttl"));
  assert.ok(attempted.includes("analytics_events_timestamp_ttl"));
});
