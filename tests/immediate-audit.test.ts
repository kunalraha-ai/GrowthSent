import assert from "node:assert/strict";
import test from "node:test";
import { dispatchImmediateAuditJob } from "../lib/jobs/immediate-audit.js";

test("immediate audit dispatch runs only the named job and releases its slot", async () => {
  const calls: string[] = [];
  const result = await dispatchImmediateAuditJob("job_immediate_test", {
    acquireSlot: async (jobId) => {
      calls.push(`acquire:${jobId}`);
      return "immediate-audit-1";
    },
    processJob: async (jobId) => {
      calls.push(`process:${jobId}`);
      return { claimed: true, status: "completed", attempt: 1, queueAgeMs: 12 };
    },
    releaseSlot: async (slotId, jobId) => {
      calls.push(`release:${slotId}:${jobId}`);
    },
  });

  assert.deepEqual(result, { dispatched: true, claimed: true, status: "completed", attempt: 1, queueAgeMs: 12 });
  assert.deepEqual(calls, [
    "acquire:job_immediate_test",
    "process:job_immediate_test",
    "release:immediate-audit-1:job_immediate_test",
  ]);
});

test("immediate audit dispatch defers without processing when all slots are occupied", async () => {
  let processed = false;
  const result = await dispatchImmediateAuditJob("job_capacity_test", {
    acquireSlot: async () => null,
    processJob: async () => {
      processed = true;
      return { claimed: true, status: "completed" };
    },
  });

  assert.deepEqual(result, { dispatched: false, claimed: false });
  assert.equal(processed, false);
});
