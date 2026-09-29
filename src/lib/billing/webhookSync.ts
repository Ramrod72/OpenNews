import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { BillingConfig } from "./config";
import type { BillingProvider, WebhookVerifySuccess } from "./provider";
import { planSlugForPriceId } from "./planMapping";
import { grantsPaidAccess } from "@/lib/entitlements";

/**
 * The minimum sufficient webhook event set (Phase 12A Amendment B
 * reassessment) — exactly three events:
 *
 *  - checkout.session.completed: the ONLY event that can link a Stripe
 *    subscription to a Veriqen user for the very first time (via the
 *    session's own subscription id) — even though it fires alongside
 *    customer.subscription.created, we never handle .created separately:
 *    this handler re-fetches full current state anyway, so a dedicated
 *    .created handler would be entirely redundant.
 *  - customer.subscription.updated: the workhorse event for every
 *    subsequent change (renewal, Portal-driven plan switch, cancellation
 *    scheduling, past_due transitions, recovery).
 *  - customer.subscription.deleted: the terminal event when a
 *    subscription is actually gone (immediate cancellation, or a
 *    cancel_at_period_end reaching its period end).
 *
 * invoice.payment_failed is deliberately NOT handled here. Stripe already
 * reflects a failed renewal payment by transitioning the subscription's
 * own `status` to "past_due"/"unpaid" and sending customer.subscription.
 * updated for it — a separate invoice handler would only duplicate that
 * signal, and Phase 12A's Amendment B explicitly warns against letting an
 * invoice event independently invent or override subscription status.
 * Omitted for Phase 12B's minimum sufficient set; would only be worth
 * adding in a future phase for proactive "your payment failed" email
 * notifications, which need an earlier signal than a status webhook alone
 * — and even then, per Amendment B, it must never itself write
 * Subscription state, only re-fetch and defer to this same sync path.
 */
export const HANDLED_WEBHOOK_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export type WebhookSyncOutcome =
  | { outcome: "processed" }
  | { outcome: "duplicate" }
  | { outcome: "ignored_event_type" }
  | { outcome: "unknown_customer" }
  | { outcome: "unknown_price" }
  | { outcome: "duplicate_subscription_conflict" }
  | { outcome: "retryable_failure"; reason: string };

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Processes one already-signature-verified webhook event. This is the
 * ONLY place Subscription rows are ever written from a webhook, and the
 * ONE place Amendment C's atomicity requirement is enforced: a
 * ProcessedWebhookEvent row is created ONLY inside the exact same
 * `prisma.$transaction` as the Subscription write it corresponds to. If
 * that transaction fails for any reason, NEITHER write commits — the
 * event is not marked processed, so the caller must return a retryable
 * (5xx) response and Stripe's own retry will re-invoke this function for
 * the same event from scratch (safe: getSubscription is a pure read, and
 * re-deriving the same current state is idempotent).
 *
 * Every branch that does NOT need a Subscription write (unknown customer,
 * unknown price) still atomically records the ProcessedWebhookEvent row
 * by itself, so Stripe stops retrying an event that no amount of retrying
 * could ever resolve — but never touches the local Subscription row when
 * it can't confidently determine what to write into it.
 */
export async function processWebhookEvent(
  prisma: PrismaClient,
  provider: BillingProvider,
  config: BillingConfig,
  verified: WebhookVerifySuccess,
): Promise<WebhookSyncOutcome> {
  if (!HANDLED_WEBHOOK_EVENT_TYPES.has(verified.eventType)) {
    return { outcome: "ignored_event_type" };
  }

  const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({
    where: { id: verified.eventId },
  });
  if (alreadyProcessed) {
    return { outcome: "duplicate" };
  }

  if (!verified.subscriptionId) {
    // A handled event type with no subscription id is not something we
    // can ever act on again by retrying — record it (dedup only) so
    // Stripe stops resending it, without touching any Subscription row.
    try {
      await prisma.processedWebhookEvent.create({
        data: { id: verified.eventId, type: verified.eventType },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
    }
    return { outcome: "ignored_event_type" };
  }

  // Authoritative re-fetch — never trust the webhook payload's own
  // embedded snapshot, which may be stale or out of order relative to
  // this current state (Phase 12A's own "re-fetch strategy" design).
  const fetched = await provider.getSubscription(verified.subscriptionId);
  if (!fetched.ok) {
    return { outcome: "retryable_failure", reason: fetched.reason };
  }
  const subscription = fetched.subscription;

  const user = await prisma.user.findUnique({
    where: { externalCustomerId: subscription.customerId },
  });
  if (!user) {
    try {
      await prisma.processedWebhookEvent.create({
        data: { id: verified.eventId, type: verified.eventType },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
    }
    return { outcome: "unknown_customer" };
  }

  const planSlug = subscription.priceId ? planSlugForPriceId(config, subscription.priceId) : null;
  if (!planSlug) {
    try {
      await prisma.processedWebhookEvent.create({
        data: { id: verified.eventId, type: verified.eventType },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
    }
    return { outcome: "unknown_price" };
  }

  const plan = await prisma.plan.findUnique({ where: { slug: planSlug } });
  if (!plan) {
    // Our OWN configuration points at a plan slug the database doesn't
    // have — an internal consistency bug (seed/config drift), not
    // something a webhook retry itself can fix, but also not safe to
    // silently swallow: fail retryable so it surfaces in logs/monitoring
    // rather than disappearing.
    return { outcome: "retryable_failure", reason: `plan slug "${planSlug}" is not seeded` };
  }

  try {
    const txResult = await prisma.$transaction(
      async (tx): Promise<{ conflict: boolean }> => {
        const existingSubscription = await tx.subscription.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
        });

        // Defense in depth against an unexpected SECOND Stripe
        // subscription for the same Veriqen user (e.g. the pre-Checkout
        // concurrency gate in checkout.ts was bypassed, raced, or this
        // user was subscribed through some other path entirely): if the
        // local row already points at a DIFFERENT subscription id that
        // currently grants paid access, this event's subscription is a
        // genuine, unexplained duplicate — never silently overwrite the
        // existing externalSubscriptionId, which would hide the first
        // (still-active, still-billing) subscription from view. This is
        // a structural conflict for a human to reconcile, not something
        // any amount of Stripe retrying could resolve on its own, so —
        // mirroring the unknown_customer/unknown_price precedent above —
        // the event is still marked processed (not retryable), but the
        // local Subscription row is left completely untouched. Never
        // auto-cancels or refunds either subscription: that action isn't
        // safe to take without a human confirming which one is the
        // "real" one to keep.
        const isDuplicateSubscriptionConflict =
          existingSubscription !== null &&
          existingSubscription.externalSubscriptionId !== null &&
          existingSubscription.externalSubscriptionId !== subscription.id &&
          grantsPaidAccess(existingSubscription.status);

        if (isDuplicateSubscriptionConflict) {
          console.error(
            "[billing] duplicate_subscription_conflict:",
            JSON.stringify({
              userId: user.id,
              customerId: subscription.customerId,
              existingSubscriptionId: existingSubscription!.externalSubscriptionId,
              existingStatus: existingSubscription!.status,
              incomingSubscriptionId: subscription.id,
              incomingStatus: subscription.status,
              eventId: verified.eventId,
              eventType: verified.eventType,
            }),
          );
          await tx.processedWebhookEvent.create({
            data: { id: verified.eventId, type: verified.eventType },
          });
          return { conflict: true };
        }

        // Preserves the "exactly one Subscription row per user" invariant
        // (see prisma/schema.prisma's own doc comment) — updates the
        // existing row in place; never inserts a second row for this user.
        if (existingSubscription) {
          await tx.subscription.update({
            where: { id: existingSubscription.id },
            data: {
              planId: plan.id,
              status: subscription.status,
              billingProvider: provider.name,
              externalSubscriptionId: subscription.id,
              externalPriceId: subscription.priceId,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              lastSyncedAt: new Date(),
            },
          });
        } else {
          // Defensive only — every real account has a row created at
          // registration (src/lib/auth/consumer/service.ts). Creating one
          // here rather than throwing keeps this function self-contained
          // if that invariant is ever violated by a data issue.
          await tx.subscription.create({
            data: {
              userId: user.id,
              planId: plan.id,
              status: subscription.status,
              billingProvider: provider.name,
              externalSubscriptionId: subscription.id,
              externalPriceId: subscription.priceId,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              lastSyncedAt: new Date(),
            },
          });
        }

        // Opportunistically frees this user's CheckoutIntent row now that
        // Stripe has confirmed current state, rather than waiting out its
        // TTL — never required for correctness (the TTL alone already
        // guarantees a user is never permanently blocked), just lets a
        // just-completed attempt's row be reused immediately by a later
        // one. A no-op if there is no pending row.
        await tx.checkoutIntent.updateMany({
          where: { userId: user.id, status: "pending" },
          data: { status: "completed" },
        });

        await tx.processedWebhookEvent.create({
          data: { id: verified.eventId, type: verified.eventType },
        });
        return { conflict: false };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    if (txResult.conflict) {
      return { outcome: "duplicate_subscription_conflict" };
    }
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // A concurrent delivery of the SAME event committed first — our
      // entire transaction (subscription write included) rolled back
      // atomically before we got here, so nothing was double-applied.
      return { outcome: "duplicate" };
    }
    return {
      outcome: "retryable_failure",
      reason: err instanceof Error ? err.message : "unknown error",
    };
  }

  return { outcome: "processed" };
}
