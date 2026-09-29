import Stripe from "stripe";
import type {
  BillingProvider,
  CheckoutSessionResult,
  CustomerResult,
  NormalizedSubscription,
  PortalSessionResult,
  SubscriptionResult,
  WebhookVerifyResult,
} from "./provider";

/** Bounded per Phase 11B's own AIProvider precedent — no outbound Stripe call in this app should hang indefinitely. */
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;
/** A webhook body this large is never a legitimate Stripe event — reject before even attempting signature verification. */
export const MAX_WEBHOOK_BODY_CHARS = 64_000;

/**
 * `current_period_start`/`current_period_end` live on each subscription
 * ITEM in this API version, not on the Subscription object itself — this
 * app never creates a subscription with more than one item, so the first
 * (only) item's period is unambiguously "the" current period.
 */
function toNormalizedSubscription(sub: Stripe.Subscription): NormalizedSubscription {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  const now = new Date();
  return {
    id: sub.id,
    customerId,
    status: sub.status,
    priceId,
    currentPeriodStart: item ? new Date(item.current_period_start * 1000) : now,
    currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : now,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

/**
 * Ollama-provider-shaped Stripe implementation of BillingProvider — the
 * ONLY file in this codebase that imports the `stripe` package. Every
 * outbound call is bounded by STRIPE_REQUEST_TIMEOUT_MS and every failure
 * mode collapses to the same small BillingFailure union the interface
 * defines, so callers never branch on a Stripe-specific error shape.
 */
export function createStripeProvider(config: {
  secretKey: string;
  webhookSecret: string;
}): BillingProvider {
  const stripe = new Stripe(config.secretKey, {
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
  });

  function classifyError(err: unknown): {
    reason: "timeout" | "network_error" | "provider_error";
    detail?: string;
  } {
    if (err instanceof Stripe.errors.StripeConnectionError) {
      return { reason: "network_error", detail: err.message };
    }
    if (err instanceof Stripe.errors.StripeError) {
      if (err.code === "ETIMEDOUT" || err.message.toLowerCase().includes("timeout")) {
        return { reason: "timeout", detail: err.message };
      }
      return { reason: "provider_error", detail: err.message };
    }
    return {
      reason: "network_error",
      detail: err instanceof Error ? err.message : "unknown error",
    };
  }

  return {
    name: "stripe",

    async createCustomer(params): Promise<CustomerResult> {
      try {
        const customer = await stripe.customers.create({
          email: params.email,
          metadata: { veriqenUserId: params.veriqenUserId },
        });
        return { ok: true, customerId: customer.id };
      } catch (err) {
        return { ok: false, ...classifyError(err) };
      }
    },

    async createCheckoutSession(params): Promise<CheckoutSessionResult> {
      try {
        const session = await stripe.checkout.sessions.create(
          {
            customer: params.customerId,
            mode: "subscription",
            line_items: [{ price: params.priceId, quantity: 1 }],
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            metadata: params.metadata,
            subscription_data: { metadata: params.metadata },
          },
          { idempotencyKey: params.idempotencyKey },
        );
        if (!session.url) {
          return {
            ok: false,
            reason: "provider_error",
            detail: "Checkout Session was created without a url",
          };
        }
        return { ok: true, url: session.url };
      } catch (err) {
        return { ok: false, ...classifyError(err) };
      }
    },

    async createPortalSession(params): Promise<PortalSessionResult> {
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: params.customerId,
          return_url: params.returnUrl,
        });
        return { ok: true, url: session.url };
      } catch (err) {
        return { ok: false, ...classifyError(err) };
      }
    },

    async getSubscription(subscriptionId): Promise<SubscriptionResult> {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        return { ok: true, subscription: toNormalizedSubscription(sub) };
      } catch (err) {
        if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) {
          return { ok: false, reason: "not_found" };
        }
        return { ok: false, ...classifyError(err) };
      }
    },

    async getCheckoutSessionSubscriptionId(sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        return { ok: true, subscriptionId };
      } catch (err) {
        if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) {
          return { ok: false, reason: "not_found" };
        }
        return { ok: false, ...classifyError(err) };
      }
    },

    verifyWebhookEvent(rawBody, signatureHeader): WebhookVerifyResult {
      if (rawBody.length > MAX_WEBHOOK_BODY_CHARS) {
        return { ok: false, reason: "oversized_payload" };
      }
      if (!signatureHeader) {
        return { ok: false, reason: "missing_signature" };
      }
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
      } catch {
        // Deliberately no error detail logged here — a signature-verification
        // failure is exactly the boundary where the payload must not yet be
        // trusted enough to even log its contents (see this module's own
        // doc comment and SECURITY.md's webhook section).
        return { ok: false, reason: "invalid_signature" };
      }

      let subscriptionId: string | null = null;
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = event.data.object as Stripe.Subscription;
        subscriptionId = subscription.id;
      }

      return { ok: true, eventId: event.id, eventType: event.type, subscriptionId };
    },
  };
}
