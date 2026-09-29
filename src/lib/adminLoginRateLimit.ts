/**
 * Phase 13B — a small, process-global (not per-IP) admin-login attempt
 * counter, layered ON TOP OF the existing per-IP limiter in
 * src/lib/rateLimit.ts (POST /api/admin/login calls both — see that
 * route). The existing per-IP limiter is defeated entirely by an
 * attacker who rotates/spoofs their source IP (or a real
 * `X-Forwarded-For` value on a deployment not behind a trusted reverse
 * proxy — see this module's own doc comment on that trust boundary,
 * which is UNCHANGED here): each new IP gets its own fresh 10-per-5-min
 * budget. This module adds a second, coarser budget that every login
 * attempt counts against regardless of source IP, so rotating IPs can
 * slow an attacker down but can no longer bypass throttling on one
 * running process entirely.
 *
 * Deliberately separate from src/lib/rateLimit.ts's own generic
 * `isRateLimited` (keyed, multi-purpose) rather than reusing it with a
 * fixed key: this gives the admin-login path its own small, dedicated,
 * independently resettable piece of state — the reset hook below is
 * test-only and must never be reachable from production code.
 *
 * In-memory and per-process, like every other rate limiter in this
 * app (see rateLimit.ts's own doc comment) — resets on restart, and is
 * NOT shared across multiple app instances/replicas. For a
 * multi-instance production deployment this is a real, documented
 * limitation (see DEPLOYMENT.md's Phase 13 section): each instance
 * enforces its own independent global budget. This is an accepted,
 * conservative defense-in-depth improvement for a single-instance
 * deployment, not a distributed rate-limiting service (explicitly out
 * of scope for Phase 13B).
 *
 * The threshold (30 attempts / 5 minutes, generously above the existing
 * per-IP limit of 10/5min) is chosen so a legitimate administrator
 * mistyping a password once or twice is never at meaningful risk of
 * tripping it, while a rotating-IP attempt to brute-force the one shared
 * admin password is still bounded on any single running process.
 */
const GLOBAL_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_LIMIT = 30;

let attemptTimestamps: number[] = [];

/**
 * Records one admin-login attempt against the process-global budget and
 * returns whether that budget is currently exhausted. Mirrors
 * rateLimit.ts's own isRateLimited() semantics exactly (filter-then-push,
 * bounded array size) but keyless, since there is intentionally only
 * ever one global bucket.
 */
export function isGlobalAdminLoginRateLimited(now: number = Date.now()): boolean {
  attemptTimestamps = attemptTimestamps.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (attemptTimestamps.length >= GLOBAL_LIMIT) {
    return true;
  }
  attemptTimestamps.push(now);
  return false;
}

/**
 * TEST-ONLY. Resets the process-global admin-login attempt counter so
 * tests can exercise this limiter deterministically without bleeding
 * state across cases or waiting out the real window. Never called from
 * any production code path.
 */
export function resetGlobalAdminLoginRateLimitForTests(): void {
  attemptTimestamps = [];
}
