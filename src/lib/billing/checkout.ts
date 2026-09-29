import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getSiteUrl } from "@/lib/siteUrl";
import { grantsPaidAccess } from "@/lib/entitlements";
import type { BillingConfig } from "./config";
import type { BillingProvider } from "./provider";
import { isPaidPlanSlug, priceIdForPlan, type PaidPlanSlug } from "./planMapping";

export type CheckoutOutcome =
  | { status: "ok"; url: string }
  | { status: "invalid_plan" }
  | { status: "already_subscribed" }
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

  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) return { status: "unavailable" };

  let customerId = user.externalCustomerId;
  if (!customerId) {
    const created = await provider.createCustomer({
      email: params.userEmail,
      veriqenUserId: params.userId,
    });
    if (!created.ok) return { status: "unavailable" };
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
    // Reused only by the Stripe SDK's own internal retry of THIS single
    // call (e.g. a network blip) — a separate call (a genuine double
    // submission) gets its own fresh key, and is harmless either way
    // (see this module's own doc comment and ARCHITECTURE.md's Phase 12B
    // section on double-checkout).
    idempotencyKey: randomUUID(),
  });
  if (!result.ok) return { status: "unavailable" };
  return { status: "ok", url: result.url };
}
