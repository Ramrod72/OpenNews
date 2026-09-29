import type { PrismaClient } from "@prisma/client";
import { getSiteUrl } from "@/lib/siteUrl";
import { grantsPaidAccess } from "@/lib/entitlements";
import type { BillingConfig } from "./config";
import type { BillingProvider } from "./provider";
import { isPaidPlanSlug, priceIdForPlan, type PaidPlanSlug } from "./planMapping";
import {
  attachCheckoutSessionId,
  deriveCheckoutIdempotencyKey,
  releaseCheckoutIntent,
  reserveOrReuseCheckoutIntent,
} from "./checkoutIntent";

export type CheckoutOutcome =
  | { status: "ok"; url: string }
  | { status: "invalid_plan" }
  | { status: "already_subscribed" }
  | { status: "checkout_in_progress" }
  | { status: "unavailable" };

/**
 * First-purchase Stripe Checkout only (Phase 12B's own locked scope — a
 * plan CHANGE for an already-paid customer is never routed through here,
 * see the "already_subscribed" outcome below; that flow is the Customer
 * Portal, src/lib/billing/portal.ts).
 *
 * `plan` is `unknown` on purpose — it is exactly the untrusted request
 * body field, validated here against the closed PaidPlanSlug set before
 * anything else touches it (STRIPE TRUST BOUNDARY: the client may request
 * only a closed plan slug, never a price id, customer id, or anything
 * else). `userId`/`userEmail` must come from the caller's own
 * authenticated-session lookup (the route handler's job) — this function
 * has no way to distinguish a real session from a forged one, so it
 * trusts whatever identity its caller already verified.
 */
export async function createCheckoutForUser(
  prisma: PrismaClient,
  provider: BillingProvider,
  config: BillingConfig,
  params: { userId: string; userEmail: string; plan: unknown },
): Promise<CheckoutOutcome> {
  if (!isPaidPlanSlug(params.plan)) {
    return { status: "invalid_plan" };
  }
  const plan: PaidPlanSlug = params.plan;

  const existing = await prisma.subscription.findFirst({
    where: { userId: params.userId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (existing && existing.plan.slug !== "free" && grantsPaidAccess(existing.status)) {
    // Never create a second paid subscription for an already-paid
    // customer through Checkout — Basic<->Pro switching and cancellation
    // both go through the Customer Portal instead (see portal.ts).
    return { status: "already_subscribed" };
  }

  // Concurrency gate: reserved BEFORE any customer/session creation, so
  // this also collapses the customer-creation race (User.externalCustomerId
  // has no per-write concurrency check of its own — see checkoutIntent.ts's
  // own doc comment for why the intent reservation, not just Stripe's
  // idempotency key, is the thing that must run first).
  const reservation = await reserveOrReuseCheckoutIntent(prisma, {
    userId: params.userId,
    planSlug: plan,
  });
  if (!reservation.ok) {
    return { status: "checkout_in_progress" };
  }
  const intent = reservation.intent;

  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) {
    await releaseCheckoutIntent(prisma, intent.id);
    return { status: "unavailable" };
  }

  let customerId = user.externalCustomerId;
  if (!customerId) {
    const created = await provider.createCustomer({
      email: params.userEmail,
      veriqenUserId: params.userId,
    });
    if (!created.ok) {
      await releaseCheckoutIntent(prisma, intent.id);
      return { status: "unavailable" };
    }
    customerId = created.customerId;
    try {
      await prisma.user.update({
        where: { id: params.userId },
        data: { externalCustomerId: customerId },
      });
    } catch {
      // A concurrent request already set a customer id (or the unique
      // constraint otherwise rejected this write) — fail closed rather
      // than proceeding with a customer id that might not be the one this
      // user's own row now actually has.
      await releaseCheckoutIntent(prisma, intent.id);
      return { status: "unavailable" };
    }
  }

  const priceId = priceIdForPlan(config, plan);
  const siteUrl = getSiteUrl();

  const result = await provider.createCheckoutSession({
    customerId,
    priceId,
    // Server-controlled, fixed-path URLs only — never derived from any
    // client-supplied value, which is what makes an open redirect via
    // this endpoint structurally impossible rather than merely validated.
    successUrl: `${siteUrl}/account?checkout=success`,
    cancelUrl: `${siteUrl}/account?checkout=canceled`,
    metadata: { veriqenUserId: params.userId },
    // Scoped to this CheckoutIntent attempt — stable across retries of
    // THIS attempt (so Stripe's own idempotency layer collapses those
    // into one session), fresh whenever the intent row is legitimately
    // reused for a genuinely NEW attempt (see checkoutIntent.ts).
    idempotencyKey: deriveCheckoutIdempotencyKey(intent),
  });
  if (!result.ok) {
    await releaseCheckoutIntent(prisma, intent.id);
    return { status: "unavailable" };
  }
  // Best-effort only: the real Stripe Checkout Session already exists at
  // this point (the user must still get their url), so a local failure to
  // record its id for reconciliation must never fail the whole request or
  // leave the user stuck on an error page after a real session was
  // already created. A retry (same intent, same derived idempotency key)
  // would get back this exact same session from Stripe regardless.
  try {
    await attachCheckoutSessionId(prisma, intent.id, result.sessionId);
  } catch {
    // Swallowed deliberately — see comment above.
  }
  return { status: "ok", url: result.url };
}
