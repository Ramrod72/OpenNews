import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

/**
 * Pre-merge concurrency hardening (Phase 12B follow-up) — closes the race
 * where two concurrent first-purchase requests for the same user could
 * each create their own real Stripe Checkout Session before either
 * completed. See prisma/schema.prisma's CheckoutIntent doc comment for the
 * schema-level invariant; this module is the ONLY writer of that table.
 *
 * How long a "pending" CheckoutIntent stays valid before it's considered
 * abandoned and eligible for reuse by a fresh attempt. Only needs to
 * outlive a realistic single checkout attempt (a browser tab open, filling
 * in payment details) while still recovering promptly if a user truly
 * abandons and comes back later — deliberately much shorter than Stripe's
 * own Checkout Session default expiry (24h), so a user is never stuck
 * behind a long-dead session.
 */
export const CHECKOUT_INTENT_TTL_MS = 30 * 60 * 1000;

export type ReserveCheckoutIntentResult =
  | { ok: true; intent: { id: string; createdAt: Date } }
  | { ok: false; reason: "in_progress_different_plan" | "lost_race" };

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Reserves (or safely reuses) the ONE CheckoutIntent row a user may have —
 * the concurrency-safe gate that MUST succeed before createCheckoutForUser
 * is allowed to call provider.createCheckoutSession. Three outcomes:
 *
 *  - No existing row: claimed for THIS attempt via `create()`. If a
 *    concurrent caller loses the resulting unique-constraint race (P2002
 *    on `userId`), it fails closed (`lost_race`) rather than falling
 *    through to reuse the winner's row — this is deliberate: it guarantees
 *    at most ONE caller ever reaches the billing provider for a genuinely
 *    new, never-before-seen attempt, so two truly simultaneous first
 *    clicks never both touch Stripe (rather than relying on both reaching
 *    Stripe with a shared idempotency key, which real Stripe would itself
 *    reject as a conflicting concurrent request).
 *  - An existing PENDING, UNEXPIRED row for the SAME plan: reused AS-IS
 *    (same `id`/`createdAt`, so the same derived idempotency key
 *    downstream — see deriveCheckoutIdempotencyKey). This is what lets a
 *    legitimate retry of ONE in-flight attempt (a page reload after a
 *    network timeout, a slightly-delayed second click that lands after
 *    the row already exists) safely reuse the exact same Stripe Checkout
 *    Session instead of creating a second one, without ever permanently
 *    blocking a later, genuinely new attempt (once this row naturally
 *    expires or is released).
 *  - An existing PENDING, UNEXPIRED row for a DIFFERENT plan: rejected
 *    (`in_progress_different_plan`) — the caller must wait for the
 *    in-flight attempt to resolve or expire before switching plans.
 *
 * The "claim a stale/expired row" path uses an atomic compare-and-swap
 * `updateMany` (re-checking the exact same staleness condition in its
 * WHERE clause, verified via `result.count === 1`) rather than a plain
 * read-then-write: under SQLite's single-writer model a naive
 * read-then-write would happen to be safe, but this schema also runs on
 * Postgres (see schema.prisma's own header comment), whose default
 * READ COMMITTED isolation lets two concurrent transactions both observe
 * the row as "reusable" before either commits. The UPDATE's WHERE-clause
 * evaluation is the actual serialization point under both databases: of
 * two concurrent UPDATEs matching the same row, only one can ever report
 * `count === 1`. The initial "no row yet" path is likewise backstopped by
 * the table's own `userId @unique` constraint, not merely this function's
 * own read-then-write ordering.
 */
export async function reserveOrReuseCheckoutIntent(
  prisma: PrismaClient,
  params: { userId: string; planSlug: string; now?: Date },
): Promise<ReserveCheckoutIntentResult> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_INTENT_TTL_MS);

  const existing = await prisma.checkoutIntent.findUnique({ where: { userId: params.userId } });

  if (!existing) {
    try {
      const created = await prisma.checkoutIntent.create({
        data: {
          userId: params.userId,
          planSlug: params.planSlug,
          status: "pending",
          createdAt: now,
          expiresAt,
        },
      });
      return { ok: true, intent: { id: created.id, createdAt: created.createdAt } };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        return { ok: false, reason: "lost_race" };
      }
      throw err;
    }
  }

  const stillPendingAndUnexpired =
    existing.status === "pending" && existing.expiresAt.getTime() > now.getTime();

  if (stillPendingAndUnexpired) {
    if (existing.planSlug !== params.planSlug) {
      return { ok: false, reason: "in_progress_different_plan" };
    }
    return { ok: true, intent: { id: existing.id, createdAt: existing.createdAt } };
  }

  const result = await prisma.checkoutIntent.updateMany({
    where: {
      userId: params.userId,
      OR: [{ status: { not: "pending" } }, { expiresAt: { lt: now } }],
    },
    data: {
      planSlug: params.planSlug,
      status: "pending",
      externalCheckoutSessionId: null,
      createdAt: now,
      expiresAt,
    },
  });

  if (result.count !== 1) {
    // A concurrent caller won the same compare-and-swap first.
    return { ok: false, reason: "lost_race" };
  }

  const refreshed = await prisma.checkoutIntent.findUniqueOrThrow({
    where: { userId: params.userId },
  });
  return { ok: true, intent: { id: refreshed.id, createdAt: refreshed.createdAt } };
}

/**
 * Releases a reserved intent after a failure downstream (customer/session
 * creation failed, or the user/session lookup itself failed) — mirrors
 * Phase 11B's reserveUsage/releaseUsage pattern exactly. Only flips a row
 * that is still "pending" (a no-op if it was already reused/replaced by a
 * later attempt), so this is always safe to call even if the caller isn't
 * sure whether release is still needed.
 */
export async function releaseCheckoutIntent(prisma: PrismaClient, intentId: string): Promise<void> {
  await prisma.checkoutIntent.updateMany({
    where: { id: intentId, status: "pending" },
    data: { status: "abandoned" },
  });
}

/** Records the real Stripe Checkout Session id on a reserved intent, for reconciliation only — never re-derived from client input. */
export async function attachCheckoutSessionId(
  prisma: PrismaClient,
  intentId: string,
  sessionId: string,
): Promise<void> {
  await prisma.checkoutIntent.updateMany({
    where: { id: intentId },
    data: { externalCheckoutSessionId: sessionId },
  });
}

/**
 * Derives the Stripe idempotency key for one attempt. Scoped to
 * (intent row id, that row's current createdAt) rather than to
 * (userId, plan) alone — a NEW attempt always gets a fresh key because
 * `createdAt` is refreshed whenever this row is legitimately reused for a
 * fresh attempt (see reserveOrReuseCheckoutIntent's compare-and-swap
 * path), while retries of the SAME attempt keep presenting the SAME key
 * so Stripe's own idempotency layer collapses them into one session. A
 * bare `hash(userId + plan)` key was deliberately rejected: it would
 * permanently return Stripe's first-ever cached (possibly long-expired)
 * Checkout Session for that user+plan forever, blocking every future
 * legitimate retry — exactly the failure mode this function must avoid.
 */
export function deriveCheckoutIdempotencyKey(intent: { id: string; createdAt: Date }): string {
  return `checkout-intent:${intent.id}:${intent.createdAt.getTime()}`;
}
