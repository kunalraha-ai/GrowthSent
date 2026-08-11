import type { IncomingMessage } from "node:http";

export const MAX_API_BODY_BYTES = 256 * 1024;

export interface ParsedRequestBody {
  tooLarge: boolean;
  body: unknown;
}

function declaredContentLength(request: IncomingMessage): number | null {
  const header = request.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Reads JSON request bodies with an allocation ceiling. This protects Vercel
 * handlers from buffering arbitrary data before application validation begins.
 */
export async function parseBoundedRequestBody(
  request: IncomingMessage,
  maxBytes = MAX_API_BODY_BYTES
): Promise<ParsedRequestBody> {
  const contentLength = declaredContentLength(request);
  if (contentLength !== null && contentLength > maxBytes) {
    request.resume();
    return { tooLarge: true, body: null };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (bytesRead > maxBytes) {
      request.destroy();
      return { tooLarge: true, body: null };
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { tooLarge: false, body: null };

  try {
    return { tooLarge: false, body: JSON.parse(raw) };
  } catch {
    // Keep the legacy router behavior: route schemas will reject non-JSON text.
    return { tooLarge: false, body: raw };
  }
}
