// Counters for usage metering, in Redis (Upstash, added to the Vercel project from the Marketplace).
// Every write is an atomic INCRBY, so parallel calls from one user can't lose an update. Configuration:
//   KV_REST_API_URL / KV_REST_API_TOKEN               set by Vercel's Upstash integration
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  the same, under Upstash's own names

/**
 * @typedef {{
 *   incr(key: string, by: number, ttlSeconds: number): Promise<number>,
 *   get(key: string): Promise<string | null>,
 *   set(key: string, value: string, ttlSeconds: number): Promise<void>,
 * }} Store
 */

/** @returns {Store | null} null when no Redis is configured. */
export function redisStore(env, fetchImpl = fetch) {
  const url = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url.startsWith('https://') || !token) return null;
  const pipeline = async (commands) => {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Redis answered with HTTP ${res.status}`);
    const out = await res.json();
    const failed = out.find((r) => r.error);
    if (failed) throw new Error(`Redis: ${failed.error}`);
    return out.map((r) => r.result);
  };
  return {
    async incr(key, by, ttlSeconds) {
      const [n] = await pipeline([
        ['INCRBY', key, String(Math.round(by))],
        ['EXPIRE', key, String(ttlSeconds)],
      ]);
      return Number(n);
    },
    async get(key) {
      const [v] = await pipeline([['GET', key]]);
      return v ?? null;
    },
    async set(key, value, ttlSeconds) {
      await pipeline([['SET', key, value, 'EX', String(ttlSeconds)]]);
    },
  };
}

/** An in-memory store for tests. */
export function memoryStore() {
  const data = new Map();
  return {
    data,
    async incr(key, by) {
      const n = Number(data.get(key) ?? 0) + Math.round(by);
      data.set(key, String(n));
      return n;
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}
