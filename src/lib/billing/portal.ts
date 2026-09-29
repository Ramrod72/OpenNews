import type { PrismaClient } from "@prisma/client";
import { getSiteUrl } from "@/lib/siteUrl";
import type { BillingProvider } from "./provider";

export type PortalOutcome =
  { status: "ok"; url: string } | { status: "no_customer" } | { status: "unavailable" };

/**
 * Creates a Stripe Customer Portal session — the single flow this app
 * delegates card updates, cancellation, reactivation, invoices, billing
 * history, AND paid-plan switching to (Basic<->Pro never goes through a
 * second Checkout Session — see checkout.ts's own "already_subscribed"
 * outcome).
 *
 * The customer id comes ONLY from the authenticated user's own DB row
 * (`params.userId`, resolved by the caller from its session, never from
 * the request body) — there is no code path here that could ever be
 * pointed at another user's Stripe customer.
 */
export async function createPortalForUser(
  prisma: PrismaClient,
  provider: BillingProvider,
  params: { userId: string },
): Promise<PortalOutcome> {
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user?.externalCustomerId) {
    return { status: "no_customer" };
  }

  const siteUrl = getSiteUrl();
  const result = await provider.createPortalSession({
    customerId: user.externalCustomerId,
    returnUrl: `${siteUrl}/account`,
  });
  if (!result.ok) return { status: "unavailable" };
  return { status: "ok", url: result.url };
}
