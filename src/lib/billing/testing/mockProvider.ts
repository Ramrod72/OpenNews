import type {
  BillingFailureReason,
  BillingProvider,
  CheckoutSessionSuccess,
  NormalizedSubscription,
  WebhookVerifyResult,
} from "../provider";

/**
 * Deterministic BillingProvider test double — directly analogous to
 * Phase 11B's mockProvider.ts (src/lib/ai/testing/mockProvider.ts). No
 * test in this repo depends on a live Stripe account, real signature
 * secret, or network call: every Phase 12B behavior (checkout, portal,
 * webhook sync, entitlement gating) is exercised against this mock
 * instead, with `webhookFixtures` letting a test hand it a pre-built
 * WebhookVerifyResult exactly as the real signature-verification code
 * would have produced one (see webhook.test.ts for the one test file
 * that additionally exercises the REAL createStripeProvider's
 * verifyWebhookEvent against a test-only signing secret, proving the
 * verification logic itself works, independent of this mock).
 */
export interface MockBillingProviderState {
  /** Every subscription this mock currently "knows about," keyed by subscription id. */
  subscriptions: Map<string, NormalizedSubscription>;
  /** Records every createCheckoutSession call for assertions. */
  checkoutCalls: Array<{ customerId: string; priceId: string; idempotencyKey: string }>;
  /** Records every createPortalSession call for assertions. */
  portalCalls: Array<{ customerId: string }>;
  /** Records every createCustomer call for assertions. */
  customerCalls: Array<{ email: string; veriqenUserId: string }>;
  /** Maps a checkout session id (as returned by createCheckoutSession's fixed url) to a subscription id. */
  checkoutSessionSubscriptions: Map<string, string | null>;
  /**
   * Maps an idempotencyKey to the CheckoutSessionSuccess it previously
   * produced — mirrors real Stripe's own idempotency-key cache
   * (https://stripe.com/docs/api/idempotent_requests): a SECOND call
   * presenting the SAME key gets back the SAME session/url rather than
   * creating a new one, which is exactly the behavior
   * reserveOrReuseCheckoutIntent()'s attempt-scoped key depends on to
   * collapse genuinely concurrent retries of one attempt into one session.
   */
  idempotencyCache: Map<string, CheckoutSessionSuccess>;
  /** Records every verifyWebhookEvent call's raw arguments for assertions (e.g. proving a caller read the raw body, not a re-serialized one). */
  webhookVerifyCalls: Array<{ rawBody: string; signatureHeader: string | null }>;
}

export interface MockBillingProviderOptions {
  /** Failure to return from getSubscription for a specific id, if set — simulates a re-fetch failure. */
  getSubscriptionFailure?: { subscriptionId: string; reason: BillingFailureReason };
  /** Failure to return from createCheckoutSession, if set. */
  checkoutFailure?: BillingFailureReason;
  /** Failure to return from createPortalSession, if set. */
  portalFailure?: BillingFailureReason;
  /** Failure to return from createCustomer, if set. */
  customerFailure?: BillingFailureReason;
}

export interface MockBillingProvider extends BillingProvider {
  readonly state: MockBillingProviderState;
  /** Test helper: registers a subscription the mock will return from getSubscription/checkout-session lookups. */
  seedSubscription(sub: NormalizedSubscription, checkoutSessionId?: string): void;
  /** Test helper: pre-loads a fixed WebhookVerifyResult that verifyWebhookEvent will return regardless of input. */
  setNextWebhookVerifyResult(result: WebhookVerifyResult): void;
}

let customerCounter = 0;

export function createMockBillingProvider(
  options: MockBillingProviderOptions = {},
): MockBillingProvider {
  const state: MockBillingProviderState = {
    subscriptions: new Map(),
    checkoutCalls: [],
    portalCalls: [],
    customerCalls: [],
    checkoutSessionSubscriptions: new Map(),
    webhookVerifyCalls: [],
    idempotencyCache: new Map(),
  };
  let nextWebhookResult: WebhookVerifyResult | null = null;

  return {
    name: "mock",
    state,

    seedSubscription(sub, checkoutSessionId) {
      state.subscriptions.set(sub.id, sub);
      if (checkoutSessionId) {
        state.checkoutSessionSubscriptions.set(checkoutSessionId, sub.id);
      }
    },

    setNextWebhookVerifyResult(result) {
      nextWebhookResult = result;
    },

    async createCustomer(params) {
      state.customerCalls.push(params);
      if (options.customerFailure) return { ok: false, reason: options.customerFailure };
      customerCounter += 1;
      return { ok: true, customerId: `cus_mock_${customerCounter}` };
    },

    async createCheckoutSession(params) {
      state.checkoutCalls.push({
        customerId: params.customerId,
        priceId: params.priceId,
        idempotencyKey: params.idempotencyKey,
      });
      const cached = state.idempotencyCache.get(params.idempotencyKey);
      if (cached) return cached;
      if (options.checkoutFailure) return { ok: false, reason: options.checkoutFailure };
      const sessionId = `cs_mock_${state.checkoutCalls.length}`;
      const result: CheckoutSessionSuccess = {
        ok: true,
        url: `https://checkout.stripe.test/${sessionId}`,
        sessionId,
      };
      state.idempotencyCache.set(params.idempotencyKey, result);
      return result;
    },

    async createPortalSession(params) {
      state.portalCalls.push({ customerId: params.customerId });
      if (options.portalFailure) return { ok: false, reason: options.portalFailure };
      return { ok: true, url: `https://billing.stripe.test/portal/${params.customerId}` };
    },

    async getSubscription(subscriptionId) {
      if (options.getSubscriptionFailure?.subscriptionId === subscriptionId) {
        return { ok: false, reason: options.getSubscriptionFailure.reason };
      }
      const sub = state.subscriptions.get(subscriptionId);
      if (!sub) return { ok: false, reason: "not_found" };
      return { ok: true, subscription: sub };
    },

    async getCheckoutSessionSubscriptionId(sessionId) {
      const subscriptionId = state.checkoutSessionSubscriptions.get(sessionId) ?? null;
      return { ok: true, subscriptionId };
    },

    verifyWebhookEvent(rawBody, signatureHeader) {
      state.webhookVerifyCalls.push({ rawBody, signatureHeader });
      if (nextWebhookResult) {
        const result = nextWebhookResult;
        nextWebhookResult = null;
        return result;
      }
      return { ok: false, reason: "missing_signature" };
    },
  };
}
