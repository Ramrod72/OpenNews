/**
 * In-memory single-flight deduplication: if a second identical request
 * (same key) arrives while the first is still generating, it awaits the
 * SAME in-flight promise instead of triggering a second provider call and
 * a second quota reservation. Same single-process scaling limitation as
 * src/lib/rateLimit.ts (documented there already) — acceptable for the
 * same reason: a self-hosted, single-instance-by-default deployment.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function withSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
