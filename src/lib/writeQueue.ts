/**
 * A small, dependency-free, process-local FIFO mutex for serializing
 * SQLite write-containing operations within this Node process.
 *
 * Why this exists: SQLite allows exactly one writer at a time. Under
 * concurrent ingestion (CONCURRENT_FETCHES sources fetched in parallel —
 * see src/lib/ingest/ingestAll.ts), each source's per-article write chain
 * (article create, keyword linking, provenance/claim persistence, status
 * writes) independently competes for that single write lock. SQLite's own
 * `busy_timeout` retries absorb brief contention, but under real
 * production write volume, enough concurrent write attempts can queue up
 * that an individual attempt's wait exceeds either `busy_timeout` (surfaced
 * as Prisma error P1008, "Socket timeout") or Prisma's own interactive-
 * transaction lifetime budget (surfaced as P2028, "transaction expired") —
 * both observed in production. Neither is caused by any one operation
 * being slow; both are caused by too many operations competing for the
 * same lock at once.
 *
 * This queue does not change what any operation does, its atomicity, or
 * any timeout value — it changes *when* each write-containing operation is
 * allowed to even attempt its first database round trip, ensuring at most
 * one is ever in flight at a time *within this process*. Once contention
 * is eliminated this way, every individual operation executes against an
 * uncontended connection and finishes in native speed, nowhere near any
 * timeout.
 *
 * Scope: this is a PROCESS-LOCAL mutex. It serializes writes made by code
 * running in the SAME Node process (the worker's own internal
 * CONCURRENT_FETCHES-driven contention — the actual observed production
 * failure). It cannot, and is not intended to, coordinate with the
 * separate `web` container's process — cross-container contention remains
 * governed by WAL mode + SQLite's own busy_timeout, exactly as before (see
 * ARCHITECTURE.md's Phase 14B entry).
 *
 * NON-REENTRANCY INVARIANT (read before adding a new call site):
 * A function that acquires this queue (i.e. calls `withWriteQueue`) must
 * NEVER, directly or indirectly, call another function that also acquires
 * this queue. This queue is a simple FIFO chain, not a reentrant lock — a
 * queued operation that tried to acquire the queue again from inside
 * itself would deadlock (its own inner acquisition would be queued behind
 * itself, which can never run because the outer acquisition is still
 * waiting on it). The current, deliberately small set of queue-acquiring
 * "leaf" functions is: persistObservationsForArticle, persistClaimsForArticle,
 * clearStaleObservations, clearStaleClaims, the article-create retry
 * helper, linkKeywords, recordSuccessStatus, and recordFailureStatus (see
 * src/lib/ingest/ingestSource.ts and src/lib/provenance/
 * persistObservations.ts / src/lib/claims/persistClaims.ts). None of
 * these calls any of the others — they are siblings in a sequential
 * chain, never nested (e.g. worker/backfill-claims.ts and worker/
 * backfill-provenance.ts each call clearStaleClaims/clearStaleObservations
 * and then separately call persistClaimsForArticle/
 * persistObservationsForArticle, one leaf acquisition after another, not
 * one inside the other). A new write-containing operation should either
 * become its own new leaf, or call an *existing* leaf — never wrap a call
 * to an existing leaf in a *new* acquisition.
 */

// The tail of the FIFO chain. Each call to withWriteQueue reads this,
// chains its own work onto it, and reassigns it — synchronously, with no
// `await` between the read and the reassignment, so concurrent calls
// (even ones that arrive in the same microtask) chain in the exact order
// they were called, giving FIFO ordering by construction.
let tail: Promise<void> = Promise.resolve();

/**
 * Runs `fn` once every previously-queued operation has finished (settled,
 * whether it resolved or rejected), and before any operation queued after
 * this call can start. Returns a promise that resolves/rejects with `fn`'s
 * own outcome — a rejection here rejects only this call's own caller; it
 * does not affect, poison, or stall the queue for anything queued before
 * or after it (the chain always advances to "settled" via `.then(noop, noop)`
 * on a side branch, independent of what the caller does with the
 * returned promise).
 */
export function withWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  const result = previous.then(fn, fn);
  // Advance the chain to the next waiter regardless of whether `fn`
  // resolved or rejected — this is the "finally"-equivalent release: the
  // next queued operation starts as soon as this one settles, never
  // blocked by this one's own success/failure outcome. No polling: the
  // next waiter's `.then` callback is scheduled by the JS engine the
  // instant this promise settles.
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
