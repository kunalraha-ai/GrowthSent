import assert from "node:assert/strict";
import test from "node:test";
import { recordMongoOperationPhase } from "../lib/db/mongo-diagnostics.js";
import { buildProductionErrorMetadata } from "../lib/api/production-error-log.js";

test("ReferenceError metadata retains only the missing identifier and our stack frames", () => {
  const error = new ReferenceError("ObjectId is not defined");
  error.stack = [
    "ReferenceError: ObjectId is not defined",
    "    at safeObjectId (/var/task/lib/db/mongodb.js:59:21)",
    "    at handleApiRequest (/var/task/lib/api/router.js:878:9)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");

  assert.deepEqual(buildProductionErrorMetadata(error, {
    route: "/api/v1/websites",
    method: "GET",
  }), {
    route: "api_v1_websites",
    method: "GET",
    errorName: "ReferenceError",
    errorMessage: "ObjectId is not defined",
    stackFrames: [
      "safeObjectId (lib/db/mongodb.js)",
      "handleApiRequest (lib/api/router.js)",
    ],
  });
});

test("unexpected ReferenceError text and untrusted route data are withheld", () => {
  const error = new ReferenceError("MONGODB_URI contains an unsafe connection value");
  error.stack = "ReferenceError\n    at handler (/var/task/api/index.js:10:2)";

  assert.deepEqual(buildProductionErrorMetadata(error, {
    route: "/api/v1/websites/0123456789abcdef01234567",
    method: "GET /private",
  }), {
    route: "api_v1_websites",
    method: "UNKNOWN",
    errorName: "ReferenceError",
    errorMessage: "ReferenceError message withheld",
    stackFrames: ["handler (api/index.js)"],
  });
});

test("MongoServerError metadata retains only static diagnostics for the failing audit operation", () => {
  const error = new Error("E11000 duplicate key error collection: GrowthSent.crawlAdmission index: _id_ dup key") as Error & {
    code?: number;
    codeName?: string;
  };
  error.name = "MongoServerError";
  error.code = 11000;
  error.codeName = "DuplicateKey";
  error.stack = [
    "MongoServerError: E11000 duplicate key error collection: GrowthSent.crawlAdmission index: _id_ dup key",
    "    at claimQueueSlot (/var/task/lib/jobs/crawl-admission.js:155:18)",
    "    at handleApiRequest (/var/task/lib/api/router.js:710:11)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");
  recordMongoOperationPhase(error, "audit_admission_queue_update");

  assert.deepEqual(buildProductionErrorMetadata(error, {
    route: "/api/v1/audit",
    method: "POST",
  }), {
    route: "api_v1_audit",
    method: "POST",
    errorName: "MongoServerError",
    mongoCode: 11000,
    mongoCodeName: "DuplicateKey",
    errorMessage: "MongoDB duplicate-key constraint conflict.",
    operationPhase: "audit_admission_queue_update",
    stackFrames: [
      "claimQueueSlot (lib/jobs/crawl-admission.js)",
      "handleApiRequest (lib/api/router.js)",
    ],
  });
});

test("MongoServerError diagnostics withhold unsafe values", () => {
  const error = new Error("MONGODB_URI contains an unsafe connection value") as Error & {
    code?: string;
    codeName?: string;
  };
  error.name = "MongoServerError";
  error.code = "unsafe code with spaces";
  error.codeName = "unsafe code with spaces";
  error.stack = "MongoServerError\n    at handler (/var/task/api/v1/[...path].js:10:2)";

  assert.deepEqual(buildProductionErrorMetadata(error, {
    route: "/api/v1/audit/secret-job-id",
    method: "POST",
  }), {
    route: "api_v1_audit",
    method: "POST",
    errorName: "MongoServerError",
    errorMessage: "MongoDB server error message withheld.",
    stackFrames: ["handler (api/v1/[...path].js)"],
  });
});
