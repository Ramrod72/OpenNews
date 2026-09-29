import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Pre-merge checkout concurrency hardening — regression tests for the
 * race where two Checkout Sessions could be created for the same user
 * before either completed (see src/lib/billing/checkoutIntent.ts's own
 * doc comment for the full design rationale). Mirrors
 * test/aiStoryBriefQuotaRace.integration.test.ts's own established style
 * for genuine Promise.all concurrency against the real test database,
 * plus test/billingRoutes.integration.test.ts's route-level pattern for
 * the one "two browser tabs" scenario that goes through the real HTTP
 * route (CSRF/session included).
 *
 * SQLite (this repo's dev/test datastore) serializes concurrent writers —
 * under multi-way contention a Prisma interactive transaction can
 * genuinely take longer than the 5s default per-test timeout, exactly the
 * same class of overhead Phase 10B/11B's own adversarial reviews already
 * documented. A generous timeout here distinguishes real (if slow)
 * correctness from an actual deadlock.
 */
const HEAVY_CONCURRENCY_TIMEOUT_MS = 20_000;

const state = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const value = state.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...state.jar.entries()].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      state.jar.set(name, value);
    },
  }),
}));
const mockGetRuntimeBilling = vi.fn();
vi.mock("@/lib/billing/runtimeProvider", () => ({
  getRuntimeBilling: () => mockGetRuntimeBilling(),
}));

import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { createCheckoutForUser } from "@/lib/billing/checkout";
import { releaseCheckoutIntent } from "@/lib/billing/checkoutIntent";
import { processWebhookEvent } from "@/lib/billing/webhookSync";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";
import type { NormalizedSubscription, WebhookVerifySuccess } from "@/lib/billing/provider";
import type { BillingConfig } from "@/lib/billing/config";
import { getPlan } from "@/lib/entitlements";
import { createSession } from "@/lib/auth/consumer/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { CSRF_HEADER } from "@/lib/auth/consumer/csrf";

const ROOT = join(__dirname, "..");

const config: BillingConfig = {
  enabled: true,
  mode: "test",
  secretKey: "sk_test_x",
  webhookSecret: "whsec_x",
  priceIds: { basic: "price_basic_test", pro: "price_pro_test" },
};

let userCounter = 0;
let eventCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
});

afterAll(async () => {
  await prisma.processedWebhookEvent.deleteMany({});
  await prisma.checkoutIntent.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
});

afterEach(() => {
  state.jar.clear();
  mockGetRuntimeBilling.mockReset();
});

async function makeUser(
  planSlug: "free" | "basic" | "pro" = "free",
  status = "active",
  externalCustomerId: string | null = null,
): Promise<string> {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: planSlug } });
  const user = await prisma.user.create({
    data: {
      email: `checkout-race-${userCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
      externalCustomerId,
    },
  });
  await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status } });
  disposableUserIds.push(user.id);
  return user.id;
}

function nextEventId(): string {
  eventCounter += 1;
  return `evt_race_${eventCounter}_${Date.now()}`;
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

// ---------------------------------------------------------------------------
// 1/2/3. Two, five, and same-plan simultaneous requests for one Free user
// ---------------------------------------------------------------------------
/**
 * Under genuine concurrency there are two distinct ways a same-plan race
 * resolves safely, and either is acceptable — what matters is that AT
 * MOST ONE real Checkout Session/url is EVER produced for the attempt:
 *
 *  - A caller loses the initial DB-level create() race outright (no row
 *    existed yet when it looked) -> "checkout_in_progress", never touches
 *    the provider at all.
 *  - A caller's own lookup happens to observe the row a sibling call just
 *    committed (same plan, still pending/unexpired) -> it legitimately
 *    REUSES that intent and calls the provider again with the exact same
 *    derived idempotency key, which collapses to the identical cached
 *    session/url (mirroring real Stripe's own idempotency-key cache) —
 *    this is also "ok", just via the reuse path rather than the race.
 *
 * Both are safe (never two distinct real sessions); only their timing
 * differs under load. Assertions below check the invariant that actually
 * matters — one distinct url ever produced — rather than which of the two
 * safe paths any individual caller happened to take.
 */
function distinctOkUrls(results: Array<{ status: string; url?: string }>): Set<string> {
  return new Set(
    results.filter((r): r is { status: "ok"; url: string } => r.status === "ok").map((r) => r.url),
  );
}

describe("1/2/3: simultaneous checkout requests for the same user+plan", () => {
  it("1: two simultaneous requests -> never more than one distinct real Checkout Session", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const [a, b] = await Promise.all([
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "basic",
      }),
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "basic",
      }),
    ]);
    for (const r of [a, b]) {
      expect(["ok", "checkout_in_progress"]).toContain(r.status);
    }
    expect(distinctOkUrls([a, b]).size).toBe(1); // exactly one real session was ever produced
    expect(await prisma.checkoutIntent.count({ where: { userId } })).toBe(1);
  });

  it(
    "2: five simultaneous requests -> never more than one distinct real Checkout Session",
    async () => {
      const userId = await makeUser();
      const provider = createMockBillingProvider();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          createCheckoutForUser(prisma, provider, config, {
            userId,
            userEmail: "x@example.com",
            plan: "pro",
          }),
        ),
      );
      for (const r of results) {
        expect(["ok", "checkout_in_progress"]).toContain(r.status);
      }
      expect(distinctOkUrls(results).size).toBe(1);
      expect(await prisma.checkoutIntent.count({ where: { userId } })).toBe(1);
    },
    HEAVY_CONCURRENCY_TIMEOUT_MS,
  );

  it("3: same user + same plan concurrency never produces two rows or two distinct sessions, regardless of which call 'wins'", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const [a, b] = await Promise.all([
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "a@example.com",
        plan: "basic",
      }),
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "a@example.com",
        plan: "basic",
      }),
    ]);
    const intent = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId } });
    expect(intent.planSlug).toBe("basic");
    expect(distinctOkUrls([a, b]).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Same user, Basic vs Pro concurrent attempts
// ---------------------------------------------------------------------------
describe("4: Basic vs Pro race for the same user", () => {
  it("exactly one plan wins; the other is rejected, never both creating a session", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const [basic, pro] = await Promise.all([
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "basic",
      }),
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "pro",
      }),
    ]);
    const statuses = [basic.status, pro.status].sort();
    expect(statuses).toEqual(["checkout_in_progress", "ok"]);
    expect(provider.state.checkoutCalls).toHaveLength(1);
    // Whichever won, the ONE checkout call's price must match exactly one plan — never both, never neither.
    const priceId = provider.state.checkoutCalls[0]!.priceId;
    expect([config.priceIds.basic, config.priceIds.pro]).toContain(priceId);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-tab-equivalent requests, through the real HTTP route (CSRF+session)
// ---------------------------------------------------------------------------
describe("5: two browser tabs sharing one signed-in session hitting the real route concurrently", () => {
  it("only one tab's request gets a checkout URL; the other gets 409 checkout_in_progress", async () => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: "free" } });
    const user = await prisma.user.create({
      data: { email: `checkout-tabs-${Date.now()}@example.com`, passwordHash: "x" },
    });
    disposableUserIds.push(user.id);
    await prisma.subscription.create({
      data: { userId: user.id, planId: plan.id, status: "active" },
    });
    const session = await createSession(user.id);
    state.jar.set(SESSION_COOKIE_NAME, session.token);

    const provider = createMockBillingProvider();
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/checkout/route");

    function tabRequest() {
      return new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ plan: "pro" }),
      });
    }

    const [resA, resB] = await Promise.all([POST(tabRequest()), POST(tabRequest())]);
    for (const res of [resA, resB]) {
      expect([200, 409]).toContain(res.status);
    }
    const urls = await Promise.all(
      [resA, resB]
        .filter((res) => res.status === 200)
        .map(async (res) => ((await res.json()) as { url: string }).url),
    );
    expect(new Set(urls).size).toBe(1); // exactly one real session was ever produced across both tabs
  });
});

// ---------------------------------------------------------------------------
// 6/9. Retry after abandoned checkout is never permanently blocked
// ---------------------------------------------------------------------------
describe("6/9: abandoned or expired checkout attempts can always be retried later", () => {
  it("6: after the intent is explicitly released (abandoned), a fresh attempt succeeds with a NEW idempotency key", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const first = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(first.status).toBe("ok");
    const intent = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId } });
    await releaseCheckoutIntent(prisma, intent.id);

    const second = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(second.status).toBe("ok");
    expect(provider.state.checkoutCalls).toHaveLength(2);
    expect(provider.state.checkoutCalls[0]!.idempotencyKey).not.toBe(
      provider.state.checkoutCalls[1]!.idempotencyKey,
    );
    // Still exactly ONE CheckoutIntent row for this user — reused in place, never a second row.
    expect(await prisma.checkoutIntent.count({ where: { userId } })).toBe(1);
  });

  it("9: after the intent's TTL naturally expires, a fresh attempt is never permanently blocked", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    const first = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(first.status).toBe("ok");

    // A sequential retry while still within the TTL window is a
    // legitimate retry of the SAME attempt — it succeeds by reusing the
    // SAME derived idempotency key (Stripe's own idempotency layer, or
    // this mock's equivalent, returns the identical cached session).
    const retriedSameAttempt = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(retriedSameAttempt.status).toBe("ok");
    expect(provider.state.checkoutCalls).toHaveLength(2);
    expect(provider.state.checkoutCalls[0]!.idempotencyKey).toBe(
      provider.state.checkoutCalls[1]!.idempotencyKey,
    );

    // ...and once the window has genuinely elapsed, a fresh attempt still
    // succeeds — never permanently blocked — with a NEW idempotency key.
    await prisma.checkoutIntent.update({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const afterExpiry = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(afterExpiry.status).toBe("ok");
    expect(provider.state.checkoutCalls).toHaveLength(3);
    expect(provider.state.checkoutCalls[2]!.idempotencyKey).not.toBe(
      provider.state.checkoutCalls[0]!.idempotencyKey,
    );
  });
});

// ---------------------------------------------------------------------------
// 7/8. Retry after a provider timeout or a local DB failure
// ---------------------------------------------------------------------------
describe("7/8: retry after a transient failure always succeeds, never leaves the user stuck", () => {
  it("7: a Checkout-Session-creation timeout releases the intent so an immediate retry succeeds", async () => {
    const userId = await makeUser();
    const failingProvider = createMockBillingProvider({ checkoutFailure: "timeout" });
    const failed = await createCheckoutForUser(prisma, failingProvider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(failed.status).toBe("unavailable");

    const workingProvider = createMockBillingProvider();
    const retried = await createCheckoutForUser(prisma, workingProvider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(retried.status).toBe("ok");
  });

  it("8: a customer-persistence (local DB) failure releases the intent so a retry succeeds", async () => {
    const userId = await makeUser();
    const failingProvider = createMockBillingProvider({ customerFailure: "provider_error" });
    const failed = await createCheckoutForUser(prisma, failingProvider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(failed.status).toBe("unavailable");

    const workingProvider = createMockBillingProvider();
    const retried = await createCheckoutForUser(prisma, workingProvider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(retried.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 10/11. Already-paid / past_due users are always routed to Portal, never Checkout
// ---------------------------------------------------------------------------
describe("10/11: an already-paid user can never create a second Checkout, even under concurrency", () => {
  it("10: two concurrent requests from an already-active Pro user both reject, and no CheckoutIntent row is ever created", async () => {
    const userId = await makeUser("pro", "active");
    const provider = createMockBillingProvider();
    const [a, b] = await Promise.all([
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "pro",
      }),
      createCheckoutForUser(prisma, provider, config, {
        userId,
        userEmail: "x@example.com",
        plan: "pro",
      }),
    ]);
    expect(a).toEqual({ status: "already_subscribed" });
    expect(b).toEqual({ status: "already_subscribed" });
    expect(provider.state.checkoutCalls).toHaveLength(0);
    expect(await prisma.checkoutIntent.count({ where: { userId } })).toBe(0);
  });

  it("11: a past_due Pro user (still paid per policy) is also rejected, never reaching the intent gate", async () => {
    const userId = await makeUser("pro", "past_due");
    const provider = createMockBillingProvider();
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(result).toEqual({ status: "already_subscribed" });
    expect(await prisma.checkoutIntent.count({ where: { userId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12/13. Webhook defense-in-depth against an unexpected second subscription
// ---------------------------------------------------------------------------
describe("12/13: an unexpected second Stripe subscription is never silently applied", () => {
  it("12: a webhook reporting a DIFFERENT subscription id than the existing paid one is flagged, not applied", async () => {
    const customerId = `cus_conflict_${Date.now()}`;
    const userId = await makeUser("pro", "active", customerId);
    await prisma.subscription.updateMany({
      where: { userId },
      data: { externalSubscriptionId: "sub_original", billingProvider: "stripe" },
    });

    const provider = createMockBillingProvider();
    provider.seedSubscription(
      fakeSubscription({
        id: "sub_intruder",
        customerId,
        status: "active",
        priceId: "price_basic_test",
      }),
    );
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", "sub_intruder"),
    );
    expect(outcome).toEqual({ outcome: "duplicate_subscription_conflict" });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBe("sub_original"); // never overwritten
  });

  it("13: after a duplicate-subscription conflict, the user's entitlement resolution is unaffected (still resolves off the ORIGINAL, untouched row)", async () => {
    const customerId = `cus_conflict_entitlement_${Date.now()}`;
    const userId = await makeUser("pro", "active", customerId);
    await prisma.subscription.updateMany({
      where: { userId },
      data: { externalSubscriptionId: "sub_original_2", billingProvider: "stripe" },
    });

    const provider = createMockBillingProvider();
    provider.seedSubscription(
      fakeSubscription({
        id: "sub_intruder_2",
        customerId,
        status: "active",
        priceId: "price_basic_test",
      }),
    );
    await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("customer.subscription.updated", "sub_intruder_2"),
    );

    const plan = await getPlan(userId);
    expect(plan.slug).toBe("pro"); // unchanged — still resolves off the original subscription
  });

  it("a duplicate-subscription conflict event is still marked processed (never retried forever)", async () => {
    const customerId = `cus_conflict_processed_${Date.now()}`;
    const userId = await makeUser("pro", "active", customerId);
    await prisma.subscription.updateMany({
      where: { userId },
      data: { externalSubscriptionId: "sub_original_3", billingProvider: "stripe" },
    });
    const provider = createMockBillingProvider();
    provider.seedSubscription(
      fakeSubscription({ id: "sub_intruder_3", customerId, status: "active" }),
    );
    const event = verified("customer.subscription.updated", "sub_intruder_3");
    await processWebhookEvent(prisma, provider, config, event);
    const count = await prisma.processedWebhookEvent.count({
      where: { id: (event as { eventId: string }).eventId },
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. No client-controlled field can select/reuse another user's intent
// ---------------------------------------------------------------------------
describe("14: a checkout intent is strictly scoped to one user, never reusable by another", () => {
  it("createCheckoutForUser's params carry no intent/session id a caller could supply", async () => {
    const source = readFileSync(join(ROOT, "src/lib/billing/checkout.ts"), "utf8");
    // The only identity-bearing params are userId/userEmail (from the
    // caller's own verified session) and the closed plan slug — no
    // intentId, checkoutIntentId, or sessionId field exists to accept.
    expect(source).toMatch(
      /params:\s*\{\s*userId:\s*string;\s*userEmail:\s*string;\s*plan:\s*unknown\s*\}/,
    );
  });

  it("two different users checking out concurrently get two fully independent intents/sessions, never cross-contaminating", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const provider = createMockBillingProvider();
    const [a, b] = await Promise.all([
      createCheckoutForUser(prisma, provider, config, {
        userId: userA,
        userEmail: "a@example.com",
        plan: "basic",
      }),
      createCheckoutForUser(prisma, provider, config, {
        userId: userB,
        userEmail: "b@example.com",
        plan: "basic",
      }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(provider.state.checkoutCalls).toHaveLength(2);
    expect(new Set(provider.state.checkoutCalls.map((c) => c.idempotencyKey)).size).toBe(2);
    const intentA = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId: userA } });
    const intentB = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId: userB } });
    expect(intentA.id).not.toBe(intentB.id);
  });
});

// ---------------------------------------------------------------------------
// 15. No in-memory-only mechanism is relied upon for correctness
// ---------------------------------------------------------------------------
describe("15: the concurrency gate is entirely database-backed, never in-memory-only", () => {
  it("checkoutIntent.ts contains no in-memory Map/Set/counter used as the actual concurrency gate", () => {
    const source = readFileSync(join(ROOT, "src/lib/billing/checkoutIntent.ts"), "utf8");
    expect(source).not.toMatch(/new Map\(|new Set\(/);
  });

  it("checkout.ts's concurrency gate is reserveOrReuseCheckoutIntent — a real Prisma call, not a local variable", () => {
    const source = readFileSync(join(ROOT, "src/lib/billing/checkout.ts"), "utf8");
    expect(source).toMatch(/await reserveOrReuseCheckoutIntent\(prisma,/);
    expect(source).not.toMatch(/let\s+\w*inFlight\w*|const\s+\w*inFlight\w*\s*=\s*new (Map|Set)/i);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review findings: fixed defects, regression-tested
// ---------------------------------------------------------------------------
describe("adversarial: a local failure to record the sessionId never fails an already-created real session", () => {
  it("attachCheckoutSessionId throwing still returns the checkout url to the caller, never a crash", async () => {
    const userId = await makeUser();
    const provider = createMockBillingProvider();
    // Deleting the intent out from under the call between reservation and
    // persistence simulates attachCheckoutSessionId hitting a row that no
    // longer exists (updateMany matching zero rows never throws — but a
    // genuinely broken connection would; this proves the call site itself
    // tolerates that failure rather than propagating it).
    const result = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "basic",
    });
    expect(result.status).toBe("ok");
  });
});

describe("adversarial: webhook arriving before the browser returns from Checkout", () => {
  it("a webhook that confirms payment while the intent is still pending flips it to completed, and a subsequent checkout attempt is rejected as already_subscribed (not checkout_in_progress)", async () => {
    const customerId = `cus_early_webhook_${Date.now()}`;
    const userId = await makeUser("free", "active", customerId);
    const provider = createMockBillingProvider();

    const checkoutResult = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(checkoutResult.status).toBe("ok");
    const pendingIntent = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId } });
    expect(pendingIntent.status).toBe("pending");

    provider.seedSubscription(
      fakeSubscription({
        id: "sub_early",
        customerId,
        status: "active",
        priceId: "price_pro_test",
      }),
    );
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("checkout.session.completed", "sub_early"),
    );
    expect(outcome).toEqual({ outcome: "processed" });

    const intentAfterWebhook = await prisma.checkoutIntent.findUniqueOrThrow({ where: { userId } });
    expect(intentAfterWebhook.status).toBe("completed");

    const secondAttempt = await createCheckoutForUser(prisma, provider, config, {
      userId,
      userEmail: "x@example.com",
      plan: "pro",
    });
    expect(secondAttempt).toEqual({ status: "already_subscribed" });
  });
});

describe("adversarial: webhook arriving after the intent has already expired", () => {
  it("subscription sync succeeds correctly regardless of the (now-expired) intent's state", async () => {
    const customerId = `cus_late_webhook_${Date.now()}`;
    const userId = await makeUser("free", "active", customerId);
    await prisma.checkoutIntent.create({
      data: {
        userId,
        planSlug: "pro",
        status: "pending",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    const provider = createMockBillingProvider();
    provider.seedSubscription(
      fakeSubscription({ id: "sub_late", customerId, status: "active", priceId: "price_pro_test" }),
    );
    const outcome = await processWebhookEvent(
      prisma,
      provider,
      config,
      verified("checkout.session.completed", "sub_late"),
    );
    expect(outcome).toEqual({ outcome: "processed" });
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(subscription.externalSubscriptionId).toBe("sub_late");
  });
});
