import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createStripeProvider, MAX_WEBHOOK_BODY_CHARS } from "./stripeProvider";

/**
 * Exercises the REAL signature-verification code path (not the mock
 * provider) against a test-only signing secret and Stripe's own
 * `generateTestHeaderString` fixture helper — proving the verification
 * logic itself works, independent of createMockBillingProvider. No
 * network call is made anywhere in this file; `generateTestHeaderString`
 * is pure local HMAC computation, and `constructEvent` is pure local
 * verification against that same secret.
 */
const TEST_WEBHOOK_SECRET = "whsec_test_only_never_a_real_secret";

function signedPayload(payload: string, secret = TEST_WEBHOOK_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

const VALID_EVENT_PAYLOAD = JSON.stringify({
  id: "evt_test_123",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_test_123", customer: "cus_test", status: "active" } },
});

describe("verifyWebhookEvent — I: a validly signed event is accepted", () => {
  it("accepts a payload signed with the matching secret and extracts the event id/type/subscription id", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const signature = signedPayload(VALID_EVENT_PAYLOAD);
    const result = provider.verifyWebhookEvent(VALID_EVENT_PAYLOAD, signature);
    expect(result).toEqual({
      ok: true,
      eventId: "evt_test_123",
      eventType: "customer.subscription.updated",
      subscriptionId: "sub_test_123",
    });
  });

  it("extracts the subscription id from a checkout.session.completed event's own session.subscription field", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const payload = JSON.stringify({
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", subscription: "sub_from_session" } },
    });
    const result = provider.verifyWebhookEvent(payload, signedPayload(payload));
    expect(result).toEqual({
      ok: true,
      eventId: "evt_checkout_1",
      eventType: "checkout.session.completed",
      subscriptionId: "sub_from_session",
    });
  });
});

describe("J: an invalid signature is rejected", () => {
  it("rejects a payload signed with a DIFFERENT secret", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const wrongSignature = signedPayload(
      VALID_EVENT_PAYLOAD,
      "whsec_a_completely_different_secret",
    );
    const result = provider.verifyWebhookEvent(VALID_EVENT_PAYLOAD, wrongSignature);
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a payload that was mutated AFTER signing (tamper detection)", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const signature = signedPayload(VALID_EVENT_PAYLOAD);
    const tampered = VALID_EVENT_PAYLOAD.replace("active", "canceled");
    const result = provider.verifyWebhookEvent(tampered, signature);
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a garbage signature header entirely", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const result = provider.verifyWebhookEvent(VALID_EVENT_PAYLOAD, "not,a=real signature");
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});

describe("K: a missing signature is rejected", () => {
  it("rejects when the stripe-signature header is entirely absent (null)", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const result = provider.verifyWebhookEvent(VALID_EVENT_PAYLOAD, null);
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("R: an oversized webhook body is rejected before any signature check", () => {
  it("rejects a body larger than MAX_WEBHOOK_BODY_CHARS even with a technically-valid-looking signature", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const hugePayload = JSON.stringify({ padding: "x".repeat(MAX_WEBHOOK_BODY_CHARS + 1000) });
    const result = provider.verifyWebhookEvent(hugePayload, signedPayload(hugePayload));
    expect(result).toEqual({ ok: false, reason: "oversized_payload" });
  });
});

describe("S/AN: a malformed (non-JSON) payload is rejected, not thrown as an unhandled exception", () => {
  it("rejects a signed-but-non-JSON body", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const malformed = "this is not json at all {{{";
    const result = provider.verifyWebhookEvent(malformed, signedPayload(malformed));
    expect(result.ok).toBe(false);
  });
});

describe("verification never leaks the secret or payload content in its result", () => {
  it("a failure result carries only a reason code, never the secret, payload, or a detail message", () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_x",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    const result = provider.verifyWebhookEvent(VALID_EVENT_PAYLOAD, "bad-signature");
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    expect(Object.keys(result)).toEqual(["ok", "reason"]);
  });
});
