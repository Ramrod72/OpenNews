import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { processWebhookEvent } from "@/lib/billing/webhookSync";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";
import type { NormalizedSubscription, WebhookVerifySuccess } from "@/lib/billing/provider";
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
let eventCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-webhook-sync", name: "Test Webhook Sync", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({});
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

async function makeUser(customerId: string): Promise<string> {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: "free" } });
  const user = await prisma.user.create({
    data: {
      email: `websync-${userCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
      externalCustomerId: customerId,
    },
  });
  await prisma.subscription.create({
    data: { userId: user.id, planId: plan.id, status: "active" },
  });
  disposableUserIds.push(user.id);
  return user.id;
}

function nextEventId(): string {
  eventCounter += 1;
  return `evt_test_${eventCounter}_${Date.now()}`;
}

function fakeSubscription(
  overrides: Partial<NormalizedSubscription> & { id: string; customerId: string },
): NormalizedSubscription {
  return {
    status: "active",
    priceId: "price_pro_test",
    currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function verified(
  eventType: string,
  subscriptionId: string | null,
  eventId = nextEventId(),
): WebhookVerifySuccess {
  return { ok: true, eventId, eventType, subscriptionId };
}

describe("ignored event types never touch the database", () => {
  it("an event type outside the handled set is a pure no-op", async () => {
    const provider = createMockBillingProvider();
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("invoice.paid", "sub_irrelevant"),
    );
    expect(outcome).toEqual({ outcome: "ignored_event_type" });
  });

  it("AY: invoice.payment_failed is NOT in the handled set — it can never independently invent or override subscription status", async () => {
    const provider = createMockBillingProvider();
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("invoice.payment_failed", "sub_x"),
    );
    expect(outcome).toEqual({ outcome: "ignored_event_type" });
    expect(provider.state.subscriptions.size).toBe(0); // never even re-fetched
  });
});

describe("L/M: duplicate webhook delivery is idempotent", () => {
  it("L: a second delivery of the exact same event id is a no-op", async () => {
    const customerId = "cus_dup_test";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_dup_test";
    provider.seedSubscription(fakeSubscription({ id: subId, customerId }));

    const event = verified("customer.subscription.updated", subId);
    const first = await processWebhookEvent(prisma, provider, config, event);
    expect(first).toEqual({ outcome: "processed" });

    const second = await processWebhookEvent(prisma, provider, config, event);
    expect(second).toEqual({ outcome: "duplicate" });

    const count = await prisma.processedWebhookEvent.count({ where: { id: event.eventId } });
    expect(count).toBe(1);
    void userId;
  });

  it("M: two CONCURRENT deliveries of the same event id result in exactly one committed sync, the other resolving as duplicate", async () => {
    const customerId = "cus_concurrent_test";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_concurrent_test";
    provider.seedSubscription(fakeSubscription({ id: subId, customerId }));

    const event = verified("customer.subscription.updated", subId);
    const [a, b] = await Promise.all([
      processWebhookEvent(prisma, provider, config, event),
      processWebhookEvent(prisma, provider, config, event),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["duplicate", "processed"]);

    const count = await prisma.processedWebhookEvent.count({ where: { id: event.eventId } });
    expect(count).toBe(1);
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBe(subId); // applied exactly once, not double-applied
  });
});

describe("N: re-fetch strategy — sync always reflects CURRENT provider state, never a stale/out-of-order snapshot", () => {
  it("regardless of which event type triggered it, the synchronized row matches whatever the provider's getSubscription currently returns", async () => {
    const customerId = "cus_refetch_test";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_refetch_test";
    // Seed the mock with subscription state that is now "canceled" — simulating
    // that a later event already superseded whatever an older, stale
    // "updated" event's own embedded payload might have said.
    provider.seedSubscription(fakeSubscription({ id: subId, customerId, status: "canceled" }));

    const staleLookingEvent = verified("customer.subscription.updated", subId);
    const outcome = await processWebhookEvent(prisma, provider, config, staleLookingEvent);
    expect(outcome).toEqual({ outcome: "processed" });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.status).toBe("canceled"); // reflects the mock's CURRENT state, not an assumed "updated means still active"
  });
});

describe("O: unknown price fails closed", () => {
  it("a subscription whose price id isn't in the trusted map is never synced — existing local state is left untouched", async () => {
    const customerId = "cus_unknown_price";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_unknown_price";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_totally_unrecognized" }),
    );

    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", subId),
    );
    expect(outcome).toEqual({ outcome: "unknown_price" });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBeNull(); // untouched
    expect(subscription.status).toBe("active"); // still the original Free row's status, not overwritten with garbage
  });

  it("records the event as processed anyway so Stripe stops retrying an event no retry could ever resolve", async () => {
    const customerId = "cus_unknown_price_2";
    await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_unknown_price_2";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_totally_unrecognized" }),
    );
    const event = verified("customer.subscription.updated", subId);

    await processWebhookEvent(prisma, provider, config, event);
    const second = await processWebhookEvent(prisma, provider, config, event);
    expect(second).toEqual({ outcome: "duplicate" });
  });
});

describe("AF/P: unknown customer fails closed", () => {
  it("a subscription belonging to a customer id with no matching local User is never synced", async () => {
    const provider = createMockBillingProvider();
    const subId = "sub_unknown_customer";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId: "cus_never_registered_anywhere" }),
    );

    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", subId),
    );
    expect(outcome).toEqual({ outcome: "unknown_customer" });
  });
});

describe("AG: unknown/unreachable subscription id fails retryable", () => {
  it("a re-fetch for a subscription id the provider doesn't recognize is a retryable failure, never silently ignored", async () => {
    const provider = createMockBillingProvider();
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", "sub_never_seeded"),
    );
    expect(outcome.outcome).toBe("retryable_failure");
  });

  it("T/U/V: a provider-side timeout/429/500 while re-fetching is a retryable failure", async () => {
    for (const reason of ["timeout", "provider_error", "network_error"] as const) {
      const provider = createMockBillingProvider({
        getSubscriptionFailure: { subscriptionId: "sub_flaky", reason },
      });
      const outcome = await processWebhookEvent(
        prisma,
        provider,
        config,
        verified("customer.subscription.updated", "sub_flaky"),
      );
      expect(outcome).toEqual({ outcome: "retryable_failure", reason });
    }
  });
});

describe("missing subscription id on a handled event type", () => {
  it("checkout.session.completed with no subscription id (e.g. a non-subscription session) is recorded and ignored, never crashes", async () => {
    const provider = createMockBillingProvider();
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("checkout.session.completed", null),
    );
    expect(outcome).toEqual({ outcome: "ignored_event_type" });
  });
});

describe("AW/AX/BG/BH: Amendment C — atomicity of the processed-event record and the subscription sync", () => {
  it("BG: on success, the Subscription write and the ProcessedWebhookEvent record commit together", async () => {
    const customerId = "cus_atomic_success";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_atomic_success";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_pro_test", status: "active" }),
    );

    const event = verified("customer.subscription.updated", subId);
    const outcome = await processWebhookEvent(prisma, provider, config, event);
    expect(outcome).toEqual({ outcome: "processed" });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBe(subId);
    expect(subscription.status).toBe("active");
    const processedRow = await prisma.processedWebhookEvent.findUnique({
      where: { id: event.eventId },
    });
    expect(processedRow).not.toBeNull();
  });

  it("AW/BH: if synchronization fails mid-transaction, the event is NOT marked processed, and the Subscription row is left untouched", async () => {
    const customerId = "cus_atomic_failure";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_atomic_failure";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_pro_test", status: "active" }),
    );

    // A prisma-like object that delegates everything to the real client
    // EXCEPT $transaction, which always fails — simulating a synchronization
    // failure (e.g. a DB outage) at exactly the point Amendment C is
    // concerned with: after the authoritative re-fetch succeeded, but
    // before the local write could commit.
    const failingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async () => {
            throw new Error("simulated synchronization failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    const event = verified("customer.subscription.updated", subId);
    const outcome = await processWebhookEvent(failingPrisma, provider, config, event);
    expect(outcome).toEqual({
      outcome: "retryable_failure",
      reason: "simulated synchronization failure",
    });

    const processedRow = await prisma.processedWebhookEvent.findUnique({
      where: { id: event.eventId },
    });
    expect(processedRow).toBeNull(); // NOT marked processed

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBeNull(); // untouched — no partial write
    expect(subscription.status).toBe("active"); // still the original Free row, unmodified

    // AX: Stripe's retry of the SAME event, against the REAL (non-failing)
    // prisma client, now succeeds and fully applies the sync.
    const retryOutcome = await processWebhookEvent(prisma, provider, config, event);
    expect(retryOutcome).toEqual({ outcome: "processed" });

    const afterRetry = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(afterRetry.externalSubscriptionId).toBe(subId);
    const processedAfterRetry = await prisma.processedWebhookEvent.findUnique({
      where: { id: event.eventId },
    });
    expect(processedAfterRetry).not.toBeNull();
  });
});

describe("preserves the exactly-one-Subscription-row-per-user invariant", () => {
  it("updates the user's existing Subscription row in place — never inserts a second row", async () => {
    const customerId = "cus_single_row";
    const userId = await makeUser(customerId);
    const before = await prisma.subscription.count({ where: { userId } });
    expect(before).toBe(1);

    const provider = createMockBillingProvider();
    const subId = "sub_single_row";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_basic_test" }),
    );
    await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", subId),
    );

    const after = await prisma.subscription.count({ where: { userId } });
    expect(after).toBe(1);
    const row = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: row.planId } });
    expect(plan.slug).toBe("basic");
  });
});

describe("checkout.session.completed uses the session's own subscription id", () => {
  it("syncs correctly when the event is a checkout completion rather than a subscription update", async () => {
    const customerId = "cus_checkout_complete";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_from_checkout";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_pro_test" }),
    );

    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("checkout.session.completed", subId),
    );
    expect(outcome).toEqual({ outcome: "processed" });
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBe(subId);
  });
});

describe("customer.subscription.deleted uses the same re-fetch-and-sync path", () => {
  it("syncs the terminal canceled state exactly like any other subscription event", async () => {
    const customerId = "cus_deleted_event";
    const userId = await makeUser(customerId);
    const provider = createMockBillingProvider();
    const subId = "sub_deleted_event";
    provider.seedSubscription(
      fakeSubscription({ id: subId, customerId, priceId: "price_pro_test", status: "canceled" }),
    );

    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.deleted", subId),
    );
    expect(outcome).toEqual({ outcome: "processed" });
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.status).toBe("canceled");
  });
});
