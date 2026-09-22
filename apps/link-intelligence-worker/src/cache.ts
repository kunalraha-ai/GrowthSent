export const DEFAULT_CACHE_TTL_SECONDS = 86_400; // 24 hours

export function cacheKey(table: string, domain: string): string {
  return `v1:${table}:${domain.toLowerCase()}`;
}

export async function getCached<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    const value = await kv.get(key, { type: "json" });
    return value as T | null;
  } catch (error) {
    console.warn("[cache] KV get failed", error);
    return null;
  }
}

export async function setCached(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch (error) {
    console.warn("[cache] KV put failed", error);
  }
}
