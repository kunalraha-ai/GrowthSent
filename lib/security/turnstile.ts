const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;

type TurnstileSiteverifyResponse = {
  success?: boolean;
};

export type TurnstileValidationResult =
  | { ok: true }
  | { ok: false; statusCode: 400 | 503; message: string };

function isProductionRuntime(): boolean {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

/**
 * Validates a single Turnstile token before a sensitive anonymous action.
 * Production fails closed if Turnstile is not configured or cannot be reached;
 * local development remains usable without a Cloudflare credential.
 */
export async function validateTurnstileToken(
  token: string | undefined,
  remoteIp: string | undefined
): Promise<TurnstileValidationResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    return isProductionRuntime()
      ? { ok: false, statusCode: 503, message: "Human verification is temporarily unavailable." }
      : { ok: true };
  }

  const normalizedToken = token?.trim();
  if (!normalizedToken || normalizedToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    return { ok: false, statusCode: 400, message: "Please complete the human verification." };
  }

  const form = new URLSearchParams({ secret, response: normalizedToken });
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    const result = (await response.json().catch(() => null)) as TurnstileSiteverifyResponse | null;
    if (!response.ok) {
      return { ok: false, statusCode: 503, message: "Human verification is temporarily unavailable." };
    }
    if (!result?.success) {
      return { ok: false, statusCode: 400, message: "Human verification failed. Please try again." };
    }
    return { ok: true };
  } catch {
    return { ok: false, statusCode: 503, message: "Human verification is temporarily unavailable." };
  }
}
