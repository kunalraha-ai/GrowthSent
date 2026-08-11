import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import { AuditInputSchema, AnalyticsCollectSchema, handleApiRequest } from "../lib/api/router";
import { normalizeAnalyticsRangeDays } from "../lib/analytics/aggregator";
import { parseBoundedRequestBody } from "../lib/api/request-body";
import { createOpaqueAccessToken, hashOpaqueAccessToken, verifyOpaqueAccessToken } from "../lib/security/access-token";
import { resolveTrustedClientIp } from "../lib/api/client-ip";

function requestFromChunks(chunks: Buffer[], contentLength?: string): IncomingMessage {
  const stream = Readable.from(chunks) as IncomingMessage;
  Object.assign(stream, { headers: contentLength ? { "content-length": contentLength } : {} });
  return stream;
}

test("request-body parser rejects oversized declared and streamed bodies", async () => {
  const declared = await parseBoundedRequestBody(requestFromChunks([], "9"), 8);
  assert.equal(declared.tooLarge, true);

  const streamed = await parseBoundedRequestBody(requestFromChunks([Buffer.alloc(4), Buffer.alloc(5)]), 8);
  assert.equal(streamed.tooLarge, true);

  const valid = await parseBoundedRequestBody(
    requestFromChunks([Buffer.from('{"url":"https://example.com"}')]),
    128
  );
  assert.deepEqual(valid, { tooLarge: false, body: { url: "https://example.com" } });
});

test("audit and analytics schemas reject unsafe relationship and oversized inputs", () => {
  assert.equal(AuditInputSchema.safeParse({ url: "https://example.com", websiteId: { $ne: null } }).success, false);
  assert.equal(
    AnalyticsCollectSchema.safeParse({
      anonymousVisitorId: "visitor-12345678",
      sessionId: "session-12345678",
      pageUrl: "not a URL",
    }).success,
    false
  );
  assert.equal(
    AnalyticsCollectSchema.safeParse({
      anonymousVisitorId: "visitor-12345678",
      sessionId: "session-12345678",
      pageUrl: "https://example.com/page",
      userAgent: "x".repeat(1025),
    }).success,
    false
  );
});

test("opaque scan capability requires the exact one-time browser token", () => {
  const token = createOpaqueAccessToken();
  const storedHash = hashOpaqueAccessToken(token);

  assert.equal(verifyOpaqueAccessToken(token, storedHash), true);
  assert.equal(verifyOpaqueAccessToken(createOpaqueAccessToken(), storedHash), false);
  assert.equal(verifyOpaqueAccessToken(undefined, storedHash), false);
});

test("client IP ignores browser X-Forwarded-For and accepts only the Vercel-attested header", () => {
  const source = {
    headers: {
      "x-forwarded-for": "203.0.113.10",
      "x-vercel-forwarded-for": "198.51.100.20",
    },
    socket: { remoteAddress: "192.0.2.30" },
  };
  assert.equal(resolveTrustedClientIp(source, false), "192.0.2.30");
  assert.equal(resolveTrustedClientIp(source, true), "198.51.100.20");
  assert.equal(
    resolveTrustedClientIp(
      { headers: { "x-vercel-forwarded-for": "198.51.100.20, 203.0.113.10" }, socket: { remoteAddress: "::ffff:192.0.2.31" } },
      true
    ),
    "192.0.2.31"
  );
});

test("OAuth callbacks fail closed when their nonce cookie is missing", async () => {
  const integration = await handleApiRequest({
    method: "GET",
    path: "/api/v1/integrations/google/callback",
    query: { code: "provider-code", state: "a".repeat(43) },
    body: null,
    headers: {},
    ip: "203.0.113.250",
  });
  assert.equal(integration.statusCode, 302);
  assert.match(String(integration.headers?.Location), /integrationError=google/);

  const socialLogin = await handleApiRequest({
    method: "GET",
    path: "/api/v1/auth/google/callback",
    query: { code: "provider-code", state: "a".repeat(43) },
    body: null,
    headers: {},
    ip: "203.0.113.251",
  });
  assert.equal(socialLogin.statusCode, 302);
  assert.match(String(socialLogin.headers?.Location), /authError=Google\+sign-in\+failed/);
});

test("analytics date ranges are bounded before querying MongoDB", () => {
  assert.equal(normalizeAnalyticsRangeDays(undefined), 30);
  assert.equal(normalizeAnalyticsRangeDays(-5), 1);
  assert.equal(normalizeAnalyticsRangeDays(3650), 90);
});

test("backlink analytics requires an authenticated application session", async () => {
  const response = await handleApiRequest({
    method: "GET",
    path: "/api/v1/backlinks",
    query: { domain: "github.com" },
    body: null,
    headers: {},
    ip: "203.0.113.252",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");
});
