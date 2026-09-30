/**
 * Minimal in-memory sliding-window rate limiter. Good enough for a
 * single-process self-hosted deployment (admin login throttling, etc.)
 * without pulling in Redis or another external dependency. Note this
 * resets on restart and isn't shared across multiple app instances —
 * documented as a scaling limitation for multi-instance deployments.
 */
const buckets = new Map<string, number[]>();

export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= limit) {
    buckets.set(key, timestamps);
    return true;
  }

  timestamps.push(now);
  buckets.set(key, timestamps);

  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t > windowMs)) buckets.delete(k);
    }
  }

  return false;
}

/**
 * Resolves the real client IP under Veriqen's supported deployment model:
 * exactly one trusted reverse proxy in front of the app (see DEPLOYMENT.md's
 * "Reverse proxy" section, which documents exactly what that proxy must
 * do). Any request can be crafted by an Internet client with an arbitrary
 * X-Forwarded-For header, so this deliberately does NOT trust the leftmost
 * (client-supplied) entry — an attacker can prepend as many fake addresses
 * as they like. Preference order:
 *
 * 1. X-Real-IP — trusted only because the documented proxy config
 *    OVERWRITES this header with its own view of the connecting peer
 *    (e.g. nginx/Caddy's `$remote_addr`/`{remote_host}`) rather than
 *    appending to a client-supplied value, so there is only ever one
 *    possible value and a client cannot influence it.
 * 2. The RIGHTMOST entry of X-Forwarded-For — the documented proxy config
 *    appends (never replaces) its own view of the connecting peer as the
 *    last entry (e.g. nginx's `$proxy_add_x_forwarded_for`, Caddy's
 *    default). With exactly one trusted hop, that appended entry is
 *    always the last one; everything to its left is unauthenticated
 *    client input and is ignored.
 * 3. "unknown" — no usable header at all (also covers a present-but-empty
 *    or all-whitespace header, so a malformed request degrades safely
 *    into one shared bucket rather than being treated as a fresh, unseen
 *    identity on every request).
 */
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return "unknown";
}

/** Test-only: clears one rate-limit bucket (or, with no key, all of them). */
export function resetRateLimitForTests(key?: string): void {
  if (key === undefined) buckets.clear();
  else buckets.delete(key);
}
