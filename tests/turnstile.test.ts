import assert from "node:assert/strict";
import test from "node:test";
import { validateTurnstileToken } from "../lib/security/turnstile";

async function withSiteverifyResponse(
  body: unknown,
  assertion: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalVercel = process.env.VERCEL;
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  process.env.VERCEL = "1";
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    await assertion();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
}

test("Turnstile explains an expired visitor token without exposing provider details", async () => {
  await withSiteverifyResponse(
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    async () => {
      assert.deepEqual(await validateTurnstileToken("visitor-token", "203.0.113.4"), {
        ok: false,
        statusCode: 400,
        message: "Human verification expired. Please complete it again.",
      });
    }
  );
});

test("Turnstile keeps ordinary visitor failures actionable but generic", async () => {
  await withSiteverifyResponse(
    { success: false, "error-codes": ["invalid-input-response"] },
    async () => {
      assert.deepEqual(await validateTurnstileToken("visitor-token", "203.0.113.5"), {
        ok: false,
        statusCode: 400,
        message: "Human verification failed. Please try again.",
      });
    }
  );
});

test("Turnstile reports an invalid configured secret as a temporary service fault", async () => {
  await withSiteverifyResponse(
    { success: false, "error-codes": ["invalid-input-secret"] },
    async () => {
      assert.deepEqual(await validateTurnstileToken("visitor-token", "203.0.113.6"), {
        ok: false,
        statusCode: 503,
        message: "Human verification is temporarily unavailable.",
      });
    }
  );
});
