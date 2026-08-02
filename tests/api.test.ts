import assert from "node:assert";
import { handleApiRequest } from "../lib/api/router";

async function testApiEndpoints() {
  console.log("Running End-to-End API Router Tests...");
  process.env.ALLOW_OFFLINE_DNS = "true";

  // 1. POST /api/v1/scans (Anonymous scan)
  const scanReq = {
    method: "POST",
    path: "/api/v1/scans",
    query: {},
    body: { url: "https://example.com" },
    headers: {},
    ip: "127.0.0.1",
  };

  const scanRes = await handleApiRequest(scanReq);
  assert.strictEqual(scanRes.statusCode, 201, "Scan request should return 201 Created");
  assert.ok(scanRes.body.scanId, "Response should contain scanId");
  assert.strictEqual(scanRes.body.status, "queued");

  // 2. GET /api/v1/scans/:id
  const getScanReq = {
    method: "GET",
    path: `/api/v1/scans/${scanRes.body.scanId}`,
    query: {},
    body: null,
    headers: {},
    ip: "127.0.0.1",
  };

  const getScanRes = await handleApiRequest(getScanReq);
  assert.strictEqual(getScanRes.statusCode, 200, "Get scan should return 200 OK");
  assert.strictEqual(getScanRes.body.url, "https://example.com/");

  // 3. POST /api/v1/auth/signup
  const testEmail = `test_${Date.now()}@example.com`;
  const signupReq = {
    method: "POST",
    path: "/api/v1/auth/signup",
    query: {},
    body: { email: testEmail, password: "password123", name: "Test Founder" },
    headers: {},
    ip: "127.0.0.1",
  };

  const signupRes = await handleApiRequest(signupReq);
  assert.strictEqual(signupRes.statusCode, 201, "Signup should return 201 Created");
  assert.ok(signupRes.headers?.["Set-Cookie"], "Signup should return session cookie");

  const sessionCookie = signupRes.headers!["Set-Cookie"];

  // 4. GET /api/v1/auth/me
  const meReq = {
    method: "GET",
    path: "/api/v1/auth/me",
    query: {},
    body: null,
    headers: { cookie: sessionCookie },
    ip: "127.0.0.1",
  };

  const meRes = await handleApiRequest(meReq);
  assert.strictEqual(meRes.statusCode, 200);
  assert.strictEqual(meRes.body.user.email, testEmail);

  // 5. POST /api/v1/websites
  const webReq = {
    method: "POST",
    path: "/api/v1/websites",
    query: {},
    body: { url: "https://myindieapp.com" },
    headers: { cookie: sessionCookie },
    ip: "127.0.0.1",
  };

  const webRes = await handleApiRequest(webReq);
  assert.strictEqual(webRes.statusCode, 201);
  assert.strictEqual(webRes.body.hostname, "myindieapp.com");

  console.log("✔ End-to-End API Router Tests Passed!");
}

testApiEndpoints().catch((err) => {
  console.error("❌ API Test Failed:", err);
  process.exit(1);
});
