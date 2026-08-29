import assert from "node:assert/strict";
import test from "node:test";
import { auditTargetValidationError, publicAuditFailure } from "../lib/services/audit-errors";
import { shouldRetryRootPageFailure } from "../lib/services/audit.service";

test("audit target validation errors are specific and safe", () => {
  const unresolvable = auditTargetValidationError("Unable to resolve host safely.");
  assert.equal(unresolvable.code, "AUDIT_HOST_UNRESOLVABLE");
  assert.equal(unresolvable.statusCode, 422);
  assert.match(unresolvable.message, /resolve this website safely/i);

  const restricted = auditTargetValidationError("Host resolves to a restricted address.");
  assert.equal(restricted.code, "AUDIT_TARGET_RESTRICTED");
  assert.equal(restricted.statusCode, 400);
  assert.match(restricted.message, /private|restricted/i);

  const malformed = auditTargetValidationError("Invalid URL format.");
  assert.equal(malformed.code, "AUDIT_URL_INVALID");
  assert.equal(malformed.statusCode, 400);
});

test("terminal audit failures retain an actionable public reason", () => {
  assert.deepEqual(publicAuditFailure("timeout"), {
    code: "AUDIT_TIMED_OUT",
    message: "The website took too long to respond. Try again shortly.",
  });
  assert.deepEqual(publicAuditFailure("non_html_response"), {
    code: "AUDIT_ROOT_NOT_HTML",
    message: "This URL does not return an HTML webpage. Try the public website homepage.",
  });
  assert.deepEqual(publicAuditFailure("unknown_future_category"), {
    code: "AUDIT_FAILED",
    message: "The audit could not be completed. Please try again later.",
  });
});

test("definitive root-page responses fail immediately while transport faults retry", () => {
  assert.equal(shouldRetryRootPageFailure("unexpected_http_status"), false);
  assert.equal(shouldRetryRootPageFailure("non_html_response"), false);
  assert.equal(shouldRetryRootPageFailure("blocked_by_safety_policy"), false);
  assert.equal(shouldRetryRootPageFailure("timeout"), true);
  assert.equal(shouldRetryRootPageFailure("network"), true);
  assert.equal(shouldRetryRootPageFailure("response_body_unavailable"), true);
});
