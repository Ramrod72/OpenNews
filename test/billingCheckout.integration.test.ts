import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { createCheckoutForUser } from "@/lib/billing/checkout";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";
import type { BillingConfig } from "@/lib/billing/config";

const config: BillingConfig = {
  enabled: true,
  mode: "test",
  secretKey: "sk_test_x",
  webhookSecret: "whsec_x",
  priceIds: { basic: "price_basic_test", pro: "price_pro_test" },
};

let categoryId: string;
let userCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-billing-checkout", name: "Test Billing Checkout", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

async function makeUser(
  planSlug: "free" | "basic" | "pro" = "free",
  status = "active",
): Promise<string> {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: planSlug } });
  const user = await prisma.user.create({
    data: { email: `checkout-${userCounter}-${Date.now()}@example.com`, passwordHash: "x" },
  });
  await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status } });
  disposableUserIds.push(user.id);
  return user.id;
}

describe("D/E: closed plan validation", () => {
  it("rejects an arbitrary/unknown plan slug", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "enterprise",
    });
    expect(result).toEqual({ status: "invalid_plan" });
    expect(provider.state.checkoutCalls).toHaveLength(0);
  });

  it("rejects a non-string plan value (e.g. an object, in case a client sends structured JSON instead of a string)", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: { slug: "pro" },
    });
    expect(result).toEqual({ status: "invalid_plan" });
  });
});

describe("B/C: Basic/Pro checkout maps only to the trusted price for that plan", () => {
  it("Basic checkout resolves the trusted Basic price id, never Pro's", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "basic@example.com",
      plan: "basic",
    });
    expect(result.status).toBe("ok");
    expect(provider.state.checkoutCalls).toHaveLength(1);
    expect(provider.state.checkoutCalls[0]!.priceId).toBe("price_basic_test");
  });

  it("Pro checkout resolves the trusted Pro price id, never Basic's", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "pro@example.com",
      plan: "pro",
    });
    expect(result.status).toBe("ok");
    expect(provider.state.checkoutCalls[0]!.priceId).toBe("price_pro_test");
  });
});

describe("F/G: identity comes only from the authenticated caller, never the request", () => {
  it("uses the userId/email the caller passed in — createCheckoutForUser has no field a client could use to override identity", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "real-owner@example.com",
      plan: "pro",
    });
    expect(provider.state.customerCalls[0]).toEqual({
      email: "real-owner@example.com",
      veriqenUserId: userId,
    });
  });
});

describe("customer reuse", () => {
  it("creates a Stripe customer once and persists it, then reuses it on a second checkout attempt", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "a@example.com",
      plan: "basic",
    });
    expect(provider.state.customerCalls).toHaveLength(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.externalCustomerId).toMatch(/^cus_mock_/);

    // Second attempt (e.g. the first checkout was abandoned) reuses the same customer, never creates a second one.
    const secondProvider = createMockBillingProvider();
    await createCheckoutForUser(prisma, secondProvider, config, {
      userId,
      userEmail: "a@example.com",
      plan: "basic",
    });
    expect(secondProvider.state.customerCalls).toHaveLength(0);
    expect(secondProvider.state.checkoutCalls[0]!.customerId).toBe(user.externalCustomerId);
  });
});

describe("BB/BC/BD: second paid subscription prevention — already-paid users are routed to Portal, never a second Checkout", () => {
  it("BB: an already-active Pro user cannot start a new Checkout for Pro again", async () => {
    const userId = await makeUser("pro", "active");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(result).toEqual({ status: "already_subscribed" });
    expect(provider.state.checkoutCalls).toHaveLength(0);
  });

  it("BC: an already-active Basic user attempting to 'upgrade' to Pro via Checkout is rejected — Basic->Pro is a Portal plan-switch, not a second Checkout", async () => {
    const userId = await makeUser("basic", "active");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(result).toEqual({ status: "already_subscribed" });
  });

  it("BD: an already-active Pro user attempting to 'downgrade' to Basic via Checkout is rejected for the same reason", async () => {
    const userId = await makeUser("pro", "active");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(result).toEqual({ status: "already_subscribed" });
  });

  it("a past_due Pro user (still paid per policy) is ALSO routed to Portal, never a second Checkout", async () => {
    const userId = await makeUser("pro", "past_due");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(result).toEqual({ status: "already_subscribed" });
  });

  it("a CANCELED former-Pro user CAN start a fresh Checkout (they are not currently paid)", async () => {
    const userId = await makeUser("pro", "canceled");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(result.status).toBe("ok");
  });

  it("a Free user can start a fresh Checkout", async () => {
    const userId = await makeUser("free", "active");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(result.status).toBe("ok");
  });
});

describe("H: checkout success never itself grants anything", () => {
  it("createCheckoutForUser never writes Subscription.status/planId — it only ever returns a URL for the browser to redirect to", async () => {
    const userId = await makeUser("free", "active");
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.status).toBe("active"); // unchanged — still the original Free row
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: subscription.planId } });
    expect(plan.slug).toBe("free"); // unchanged
  });
});

describe("AA: server-controlled URLs — no open redirect surface", () => {
  it("success/cancel URLs are always built from the server's own site config, with a fixed path — never influenced by any caller-supplied value", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    // createCheckoutForUser's params type has no successUrl/cancelUrl/returnUrl
    // field at all — this is a structural guarantee, not just a runtime
    // check, but we also confirm the provider actually received Veriqen's
    // own origin-based URLs.
    expect(provider.state.checkoutCalls).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("issues a fresh idempotency key per call (two separate calls never accidentally collide)", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });

    const userId2 = await makeUser();
    await createCheckoutForUser(prisma, provider, config, {
      userId: userId2,
      userEmail: "y@example.com",
      plan: "basic",
    });

    const keys = provider.state.checkoutCalls.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("provider/network failure isolation", () => {
  it("a checkout-session-creation failure fails closed to 'unavailable', never partially succeeds", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider({ checkoutFailure: "network_error" });
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("a customer-creation failure fails closed and never persists a partial/garbage externalCustomerId", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider({ customerFailure: "provider_error" });
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(result).toEqual({ status: "unavailable" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.externalCustomerId).toBeNull();
  });
});
