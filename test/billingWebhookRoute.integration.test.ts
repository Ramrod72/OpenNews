import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";
import type { BillingConfig } from "@/lib/billing/config";
import { MAX_WEBHOOK_BODY_CHARS } from "@/lib/billing/stripeProvider";

/**
 * Route-level tests for POST /api/billing/webhook, with
 * getRuntimeBilling() mocked to inject the deterministic mock provider —
 * see src/lib/billing/stripeProvider.test.ts for real signature
 * verification against a test-only secret, and
 * test/billingWebhookSync.integration.test.ts for the real synchronization
 * logic against a real database. This file's own job is narrower: proving
 * the ROUTE ITSELF reads the exact raw body (never a parsed/re-serialized
 * one), bounds its size, and maps every processWebhookEvent outcome to
 * the correct HTTP status.
 */
const mockGetRuntimeBilling = vi.fn();
vi.mock("@/lib/billing/runtimeProvider", () => ({
  getRuntimeBilling: () => mockGetRuntimeBilling(),
}));

const config: BillingConfig = {
  enabled: true,
  mode: "test",
  secretKey: "sk_test_x",
  webhookSecret: "whsec_x",
  priceIds: { basic: "price_basic_test", pro: "price_pro_test" },
};

let categoryId: string;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-webhook-route", name: "Test Webhook Route", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({});
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(() => {
  mockGetRuntimeBilling.mockReset();
});

function postWebhook(body: string, signature: string | null = "sig_placeholder") {
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body,
  });
}

describe("body bounding (R: excessive webhook body)", () => {
  it("rejects a body larger than MAX_WEBHOOK_BODY_CHARS with 413, before ever consulting billing config", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const hugeBody = "x".repeat(MAX_WEBHOOK_BODY_CHARS + 1000);
    const res = await POST(postWebhook(hugeBody));
    expect(res.status).toBe(413);
    expect(mockGetRuntimeBilling).not.toHaveBeenCalled();
  });
});

describe("BE: billing not configured", () => {
  it("returns 503 and never calls verifyWebhookEvent when billing is disabled", async () => {
    mockGetRuntimeBilling.mockReturnValue({ enabled: false, reason: "not configured" });
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(postWebhook('{"id":"evt_1"}'));
    expect(res.status).toBe(503);
  });
});

describe("raw body integrity", () => {
  it("passes the EXACT raw request body to verifyWebhookEvent — never a parsed-and-re-serialized copy", async () => {
    const provider = createMockBillingProvider();
    provider.setNextWebhookVerifyResult({ ok: false, reason: "invalid_signature" });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    // Deliberately unusual whitespace/key-order that a JSON.parse+stringify
    // round-trip would normalize away — proving the route reads bytes, not semantics.
    const rawBody = '{"id" :  "evt_weird_spacing"   , "type":"x"}';
    await POST(postWebhook(rawBody, "sig_abc"));

    expect(provider.state.webhookVerifyCalls).toEqual([{ rawBody, signatureHeader: "sig_abc" }]);
  });

  it("passes the signature header through unchanged, and null when absent", async () => {
    const provider = createMockBillingProvider();
    provider.setNextWebhookVerifyResult({ ok: false, reason: "missing_signature" });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    await POST(postWebhook("{}", null));
    expect(provider.state.webhookVerifyCalls[0]!.signatureHeader).toBeNull();
  });
});

describe("J/K: invalid or missing signature -> 400, never processed further", () => {
  it("returns 400 when verifyWebhookEvent reports invalid_signature", async () => {
    const provider = createMockBillingProvider();
    provider.setNextWebhookVerifyResult({ ok: false, reason: "invalid_signature" });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    const res = await POST(postWebhook("{}", "bad-sig"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when verifyWebhookEvent reports missing_signature", async () => {
    const provider = createMockBillingProvider();
    provider.setNextWebhookVerifyResult({ ok: false, reason: "missing_signature" });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    const res = await POST(postWebhook("{}", null));
    expect(res.status).toBe(400);
  });
});

describe("successful processing outcomes all acknowledge with 200", () => {
  it("an ignored/unhandled event type returns 200", async () => {
    const provider = createMockBillingProvider();
    provider.setNextWebhookVerifyResult({
      ok: true,
      eventId: "evt_ignored",
      eventType: "invoice.paid",
      subscriptionId: null,
    });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    const res = await POST(postWebhook("{}", "sig"));
    expect(res.status).toBe(200);
  });

  it("a full successful synchronization returns 200", async () => {
    const provider = createMockBillingProvider();
    const user = await prisma.user.create({
      data: {
        email: `webhook-route-${Date.now()}@example.com`,
        passwordHash: "x",
        externalCustomerId: "cus_route_test",
      },
    });
    disposableUserIds.push(user.id);
    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { slug: "free" } });
    await prisma.subscription.create({
      data: { userId: user.id, planId: freePlan.id, status: "active" },
    });

    provider.seedSubscription({
      id: "sub_route_test",
      customerId: "cus_route_test",
      status: "active",
      priceId: "price_pro_test",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
    });
    provider.setNextWebhookVerifyResult({
      ok: true,
      eventId: "evt_route_success",
      eventType: "customer.subscription.updated",
      subscriptionId: "sub_route_test",
    });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    const res = await POST(postWebhook("{}", "sig"));
    expect(res.status).toBe(200);
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(subscription.externalSubscriptionId).toBe("sub_route_test");
  });
});

describe("W/BH: a retryable sync failure returns 500 so Stripe retries", () => {
  it("returns 500 (never 2xx) when the authoritative re-fetch itself fails", async () => {
    const provider = createMockBillingProvider({
      getSubscriptionFailure: { subscriptionId: "sub_will_fail", reason: "network_error" },
    });
    provider.setNextWebhookVerifyResult({
      ok: true,
      eventId: "evt_will_fail",
      eventType: "customer.subscription.updated",
      subscriptionId: "sub_will_fail",
    });
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/webhook/route");

    const res = await POST(postWebhook("{}", "sig"));
    expect(res.status).toBe(500);
  });
});
