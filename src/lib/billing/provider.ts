/**
 * Phase 12B's narrow billing abstraction — directly analogous to Phase
 * 11B's AIProvider boundary (src/lib/ai/provider.ts). Product/orchestration
 * code (the checkout/portal/webhook routes, and eventually entitlements.ts)
 * depends only on this interface, never on the Stripe SDK's own shapes —
 * so the Stripe SDK is imported in exactly one file
 * (src/lib/billing/stripeProvider.ts), and every other billing-aware
 * module (and every test) can run against the deterministic mock
 * implementation (src/lib/billing/testing/mockProvider.ts) instead.
 *
 * Stripe answers "what commercial subscription state does this customer
 * have"; this interface is the ONLY channel that answer travels through
 * into the rest of the app — see src/lib/billing/webhookSync.ts and
 * src/lib/entitlements.ts for where it's consumed.
 */

/** Veriqen's own normalized view of a Stripe Subscription object — the only shape any caller outside this module ever sees. */
export interface NormalizedSubscription {
  /** The Stripe subscription id (e.g. "sub_..."). */
  id: string;
  /** The Stripe customer id (e.g. "cus_...") this subscription belongs to. */
  customerId: string;
  /**
   * Stripe's own status string, passed through verbatim — never re-encoded
   * here. Whether a given value grants paid access is decided in exactly
   * one place (src/lib/entitlements.ts), not in this module.
   */
  status: string;
  /**
   * The Stripe Price id of this subscription's single line item. This app
   * never creates a subscription with more than one price/line item, so
   * "the" price is unambiguous; null only if Stripe's own object
   * unexpectedly has zero items (defensive — should not occur in practice).
   */
  priceId: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export type BillingFailureReason =
  "timeout" | "network_error" | "provider_error" | "not_found" | "misconfigured";

export interface BillingFailure {
  ok: false;
  reason: BillingFailureReason;
  detail?: string;
}

export interface CheckoutSessionSuccess {
  ok: true;
  url: string;
  /** The Stripe Checkout Session id (e.g. "cs_..."), stored on CheckoutIntent for reconciliation — see src/lib/billing/checkoutIntent.ts. */
  sessionId: string;
}
export type CheckoutSessionResult = CheckoutSessionSuccess | BillingFailure;

export interface PortalSessionSuccess {
  ok: true;
  url: string;
}
export type PortalSessionResult = PortalSessionSuccess | BillingFailure;

export interface CustomerSuccess {
  ok: true;
  customerId: string;
}
export type CustomerResult = CustomerSuccess | BillingFailure;

export interface SubscriptionSuccess {
  ok: true;
  subscription: NormalizedSubscription;
}
export type SubscriptionResult = SubscriptionSuccess | BillingFailure;

export interface WebhookVerifySuccess {
  ok: true;
  /** Stripe's own event id (e.g. "evt_..."), used for idempotency (ProcessedWebhookEvent.id). */
  eventId: string;
  /** e.g. "customer.subscription.updated". */
  eventType: string;
  /**
   * The subscription id this event concerns, if any — extracted here so
   * callers never need to inspect the raw event payload shape themselves.
   * Present for checkout.session.completed (the session's own subscription
   * id) and for customer.subscription.* events (the object's own id).
   * The embedded object itself is intentionally NOT exposed further than
   * this id: callers must re-fetch current state via getSubscription()
   * rather than trusting anything else this payload says (see
   * src/lib/billing/webhookSync.ts).
   */
  subscriptionId: string | null;
}
export type WebhookVerifyFailure = {
  ok: false;
  reason: "invalid_signature" | "missing_signature" | "malformed_payload" | "oversized_payload";
};
export type WebhookVerifyResult = WebhookVerifySuccess | WebhookVerifyFailure;

export interface BillingProvider {
  /** Stable identifier, e.g. "stripe" — persisted as Subscription.billingProvider. */
  readonly name: string;

  /**
   * Finds or creates a Stripe Customer for this Veriqen user. Implementations
   * must be safe to call when a customer already exists (idempotent lookup
   * by the caller's own already-stored id — see checkout route) — this
   * method itself only ever CREATES, the caller decides whether creation is
   * needed by checking User.externalCustomerId first.
   */
  createCustomer(params: { email: string; veriqenUserId: string }): Promise<CustomerResult>;

  /**
   * Creates a Checkout Session for a single subscription price. `metadata`
   * is attached to the session (and Stripe copies it onto the resulting
   * subscription) so a webhook can cross-check identity — never trusted as
   * the SOLE source of identity (see webhookSync.ts's customer-id lookup).
   */
  createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<CheckoutSessionResult>;

  /** Creates a Stripe Customer Portal session for an existing customer. */
  createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalSessionResult>;

  /**
   * Retrieves the CURRENT subscription state directly from Stripe — the
   * one call every webhook handler uses instead of trusting a possibly
   * stale/out-of-order event payload (see webhookSync.ts).
   */
  getSubscription(subscriptionId: string): Promise<SubscriptionResult>;

  /**
   * Given a Checkout Session id, returns the subscription id it created —
   * used only by the checkout.session.completed handler, which otherwise
   * has no subscription id to re-fetch with.
   */
  getCheckoutSessionSubscriptionId(
    sessionId: string,
  ): Promise<{ ok: true; subscriptionId: string | null } | BillingFailure>;

  /**
   * Verifies a webhook request's signature against the raw request body —
   * MUST be called before any payload field is trusted or parsed further.
   * `rawBody` must be the exact, unparsed bytes/string Stripe signed; a
   * caller that has already JSON-parsed and re-serialized the body will
   * fail verification (this is intentional — see the webhook route's own
   * doc comment on reading the raw body first).
   */
  verifyWebhookEvent(rawBody: string, signatureHeader: string | null): WebhookVerifyResult;
}
