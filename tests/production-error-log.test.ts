import assert from "node:assert/strict";
import test from "node:test";
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
  const error = new ReferenceError("MONGODB_URI mongodb+srv://secret.example is not valid");
  error.stack = "ReferenceError\n    at handler (/var/task/api/index.js:10:2)";

  assert.deepEqual(buildProductionErrorMetadata(error, {
    route: "/api/v1/websites/0123456789abcdef01234567",
    method: "GET /private",
  }), {
    route: "other_api_route",
    method: "UNKNOWN",
    errorName: "ReferenceError",
    errorMessage: "ReferenceError message withheld",
    stackFrames: ["handler (api/index.js)"],
  });
});
