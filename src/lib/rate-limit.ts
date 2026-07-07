/**
 * Lightweight per-instance rate limiter for the public API routes. A warm
 * serverless instance keeps its buckets in memory, so this stops naive
 * spam loops (draft-order spam, upload floods) without any external store.
 * It is NOT a hard global guarantee — parallel cold instances each get
 * their own buckets; Turnstile or an Upstash limiter is the upgrade if
 * real abuse ever shows up.
 */

const buckets = new Map<string, number[]>();

export function rateLimit(id: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(id) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(id, hits);
    return false;
  }
  hits.push(now);
  buckets.set(id, hits);
  // keep the map from growing unbounded on long-lived instances
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return true;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}
