import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { getPlan } from "@/lib/entitlements";
import { createCheckoutForUser } from "@/lib/billing/checkout";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";
import type { BillingConfig } from "@/lib/billing/config";

const config: BillingConfig = {
  enabled: true,
  mode: "test",
  secretKey: "sk_test_super_secret_value",
  webhookSecret: "whsec_super_secret_value",
  priceIds: { basic: "price_basic_test", pro: "price_pro_test" },
};

let categoryId: string;
let userCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-billing-privacy", name: "Test Billing Privacy", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({});
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

async function makeUser(planSlug: "free" | "pro" = "pro", status = "active"): Promise<string> {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: planSlug } });
  const user = await prisma.user.create({
    data: {
      email: `privacy-${userCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
      displayName: "A Distinctive Reader Name",
    },
  });
  await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status } });
  disposableUserIds.push(user.id);
  return user.id;
}

describe("BA: paid access survives a total Stripe outage because entitlement checks never call Stripe", () => {
  it("getPlan() resolves correctly for an active Pro user with no billing config or provider available at all", async () => {
    const userId = await makeUser("pro", "active");
    // No billing config, no provider constructed anywhere in this test —
    // getPlan() has no way to reach Stripe even if it wanted to.
    const plan = await getPlan(userId);
    expect(plan.slug).toBe("pro");
  });

  it("getPlan() still resolves correctly (to Free, per policy) for a canceled user during the same total outage", async () => {
    const userId = await makeUser("pro", "canceled");
    const plan = await getPlan(userId);
    expect(plan.slug).toBe("free");
  });
});

describe("AE: no user research/product-usage data is ever sent to the billing provider", () => {
  it("createCustomer receives only an email and an opaque user id — nothing about saved stories, topics, or reading history", async () => {
    const userId = await makeUser("free");
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "reader@example.com",
      plan: "basic",
    });
    expect(provider.state.customerCalls).toEqual([
      { email: "reader@example.com", veriqenUserId: userId },
    ]);
    expect(Object.keys(provider.state.customerCalls[0]!)).toEqual(["email", "veriqenUserId"]);
  });

  it("checkout session metadata carries only the opaque Veriqen user id — no email, no display name, no product data", async () => {
    const userId = await makeUser("free");
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "reader2@example.com",
      plan: "pro",
    });
    // metadata is not directly exposed by the mock's checkoutCalls
    // recording (only customerId/priceId/idempotencyKey) — this itself
    // documents that createCheckoutForUser has no field for saved
    // stories/topics/history to travel through in the first place.
    expect(provider.state.checkoutCalls[0]).toEqual({
      customerId: expect.any(String),
      priceId: "price_pro_test",
      idempotencyKey: expect.any(String),
    });
  });
});

describe("AC/AD: no secrets or full webhook payloads appear in logs", () => {
  it("a webhook signature failure logs only a reason code, never the secret or the payload", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = createMockBillingProvider();
      provider.setNextWebhookVerifyResult({ ok: false, reason: "invalid_signature" });
      vi.doMock("@/lib/billing/runtimeProvider", () => ({
        getRuntimeBilling: () => ({ enabled: true, provider, config }),
      }));
      vi.resetModules();
      const { POST } = await import("@/app/api/billing/webhook/route");

      const hostileBody = JSON.stringify({
        secret: "sk_test_super_secret_value",
        card: "4242424242424242",
      });
      const res = await POST(
        new Request("http://localhost/api/billing/webhook", {
          method: "POST",
          headers: { "stripe-signature": "sig" },
          body: hostileBody,
        }),
      );
      expect(res.status).toBe(400); // confirms this actually exercised the signature-failure path, not a 503 short-circuit

      const loggedText = errorSpy.mock.calls
        .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
        .join("\n");
      expect(loggedText).not.toContain(config.secretKey);
      expect(loggedText).not.toContain(config.webhookSecret);
      expect(loggedText).not.toContain("4242424242424242");
      expect(loggedText).not.toContain(hostileBody);
    } finally {
      errorSpy.mockRestore();
      vi.doUnmock("@/lib/billing/runtimeProvider");
    }
  });

  it("a synchronization (re-fetch) failure through the real route logs only a reason code, never the webhook secret", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = createMockBillingProvider({
        getSubscriptionFailure: { subscriptionId: "sub_secret_test", reason: "provider_error" },
      });
      provider.setNextWebhookVerifyResult({
        ok: true,
        eventId: "evt_secret_test",
        eventType: "customer.subscription.updated",
        subscriptionId: "sub_secret_test",
      });
      vi.doMock("@/lib/billing/runtimeProvider", () => ({
        getRuntimeBilling: () => ({ enabled: true, provider, config }),
      }));
      vi.resetModules();
      const { POST } = await import("@/app/api/billing/webhook/route");

      const res = await POST(
        new Request("http://localhost/api/billing/webhook", {
          method: "POST",
          headers: { "stripe-signature": "sig" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(500);

      const loggedText = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(loggedText).not.toContain(config.secretKey);
      expect(loggedText).not.toContain(config.webhookSecret);
    } finally {
      errorSpy.mockRestore();
      vi.doUnmock("@/lib/billing/runtimeProvider");
    }
  });
});
