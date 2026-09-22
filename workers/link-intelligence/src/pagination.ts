import type { Cursor } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function parsePagination(searchParams: URLSearchParams, envMax: string | undefined): { limit: number; offset: number } {
  let limit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = DEFAULT_LIMIT;
  }
  const configuredMax = Number(envMax ?? MAX_LIMIT);
  limit = Math.min(limit, Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : MAX_LIMIT);

  let offset = 0;
  const cursor = searchParams.get("cursor");
  if (cursor) {
    try {
      const decoded = JSON.parse(atob(cursor)) as Cursor;
      if (Number.isFinite(decoded.offset) && decoded.offset >= 0) {
        offset = decoded.offset;
      }
    } catch {
      // Invalid cursor falls back to offset 0.
    }
  }

  return { limit, offset };
}

export function encodeCursor(offset: number): string | null {
  if (offset <= 0) return null;
  return btoa(JSON.stringify({ offset } as Cursor));
}
