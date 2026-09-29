import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import {
  can,
  checkUsage,
  getLimit,
  getPlan,
  grantsPaidAccess,
  recordUsage,
} from "@/lib/entitlements";

let freeUserId: string;
let basicUserId: string;
let proUserId: string;

beforeAll(async () => {
  await seedPlans(prisma);

  const [freePlan, basicPlan, proPlan] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { slug: "free" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "basic" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } }),
  ]);

  const [freeUser, basicUser, proUser] = await Promise.all([
    prisma.user.create({ data: { email: "free-ent@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "basic-ent@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "pro-ent@example.com", passwordHash: "x" } }),
  ]);
  freeUserId = freeUser.id;
  basicUserId = basicUser.id;
  proUserId = proUser.id;

  await Promise.all([
    prisma.subscription.create({
      data: { userId: freeUserId, planId: freePlan.id, status: "active" },
    }),
    prisma.subscription.create({
      data: { userId: basicUserId, planId: basicPlan.id, status: "active" },
    }),
    prisma.subscription.create({
      data: { userId: proUserId, planId: proPlan.id, status: "active" },
    }),
  ]);
});

afterAll(async () => {
  await prisma.usageRecord.deleteMany({
    where: { userId: { in: [freeUserId, basicUserId, proUserId] } },
  });
  await prisma.subscription.deleteMany({
    where: { userId: { in: [freeUserId, basicUserId, proUserId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [freeUserId, basicUserId, proUserId] } } });
  await prisma.$disconnect();
});

describe("getPlan", () => {
  it("resolves anonymous visitors (null) to the Free plan", async () => {
    const plan = await getPlan(null);
    expect(plan.slug).toBe("free");
    expect(plan.entitlements.ads_enabled.boolValue).toBe(true);
    expect(plan.entitlements.ai_summaries.boolValue).toBe(false);
  });

  it("resolves a registered free user to the Free plan", async () => {
    const plan = await getPlan(freeUserId);
    expect(plan.slug).toBe("free");
    expect(plan.entitlements.saved_stories_limit.limitValue).toBe(10);
  });

  it("resolves a Basic subscriber to the Basic plan", async () => {
    const plan = await getPlan(basicUserId);
    expect(plan.slug).toBe("basic");
    expect(plan.entitlements.ads_enabled.boolValue).toBe(false);
    expect(plan.entitlements.search_full.boolValue).toBe(true);
    expect(plan.entitlements.saved_stories_limit.limitValue).toBeNull(); // unlimited
    expect(plan.entitlements.ai_summaries.boolValue).toBe(false); // Pro-only
  });

  it("resolves a Pro subscriber to the Pro plan", async () => {
    const plan = await getPlan(proUserId);
    expect(plan.slug).toBe("pro");
    expect(plan.entitlements.ai_summaries.boolValue).toBe(true);
    expect(plan.entitlements.cross_source_synthesis.boolValue).toBe(true);
    expect(plan.entitlements.ai_monthly_quota.limitValue).toBe(50);
  });
});

describe("can (boolean entitlement)", () => {
  it("differs correctly across anonymous/free/basic/pro for ads_enabled", async () => {
    expect(await can(null, "ads_enabled")).toBe(true);
    expect(await can(freeUserId, "ads_enabled")).toBe(true);
    expect(await can(basicUserId, "ads_enabled")).toBe(false);
    expect(await can(proUserId, "ads_enabled")).toBe(false);
  });

  it("gates ai_summaries to Pro only", async () => {
    expect(await can(freeUserId, "ai_summaries")).toBe(false);
    expect(await can(basicUserId, "ai_summaries")).toBe(false);
    expect(await can(proUserId, "ai_summaries")).toBe(true);
  });

  it("fails closed for an unknown feature key (no accidental access from a typo)", async () => {
    expect(await can(proUserId, "totally_made_up_feature")).toBe(false);
  });
});

describe("getLimit (quota entitlement)", () => {
  it("returns 10 for Free saved_stories_limit and null (unlimited) for Basic/Pro", async () => {
    expect(await getLimit(freeUserId, "saved_stories_limit")).toBe(10);
    expect(await getLimit(basicUserId, "saved_stories_limit")).toBeNull();
    expect(await getLimit(proUserId, "saved_stories_limit")).toBeNull();
  });

  it("returns 0 (not null) for an unknown feature — fail closed, not fail open", async () => {
    expect(await getLimit(freeUserId, "totally_made_up_feature")).toBe(0);
  });
});

describe("checkUsage", () => {
  it("Free plan's ai_monthly_quota is 0, so usage is never allowed even at zero recorded uses", async () => {
    const result = await checkUsage(freeUserId, "ai_monthly_quota");
    expect(result).toEqual({ allowed: false, used: 0, limit: 0 });
  });

  it("Basic/Pro saved_stories_limit is unlimited and always allowed", async () => {
    const result = await checkUsage(basicUserId, "saved_stories_limit");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });

  it("tracks Pro ai_monthly_quota usage and flips to not-allowed once the limit is reached", async () => {
    const period = new Date("2026-01-15T00:00:00Z");
    for (let i = 0; i < 50; i++) {
      await recordUsage(proUserId, "ai_monthly_quota", period);
    }
    const atLimit = await checkUsage(proUserId, "ai_monthly_quota", period);
    expect(atLimit).toEqual({ allowed: false, used: 50, limit: 50 });

    // A different calendar month is a fresh quota window.
    const nextMonth = new Date("2026-02-01T00:00:00Z");
    const freshPeriod = await checkUsage(proUserId, "ai_monthly_quota", nextMonth);
    expect(freshPeriod).toEqual({ allowed: true, used: 0, limit: 50 });
  });

  it("anonymous visitors report their plan's limit without a usage lookup", async () => {
    const result = await checkUsage(null, "ai_monthly_quota");
    expect(result).toEqual({ allowed: false, used: 0, limit: 0 });
  });
});

describe("grantsPaidAccess (Phase 12B locked status matrix)", () => {
  it("active and past_due grant paid access", () => {
    expect(grantsPaidAccess("active")).toBe(true);
    expect(grantsPaidAccess("past_due")).toBe(true);
  });

  it("unpaid, canceled, incomplete, incomplete_expired, and paused do NOT grant paid access", () => {
    expect(grantsPaidAccess("unpaid")).toBe(false);
    expect(grantsPaidAccess("canceled")).toBe(false);
    expect(grantsPaidAccess("incomplete")).toBe(false);
    expect(grantsPaidAccess("incomplete_expired")).toBe(false);
    expect(grantsPaidAccess("paused")).toBe(false);
  });

  it("trialing does not grant paid access — trials are not deliberately enabled in Phase 12B", () => {
    expect(grantsPaidAccess("trialing")).toBe(false);
  });

  it("AZ: an unrecognized/future Stripe status fails closed", () => {
    expect(grantsPaidAccess("some_future_status_stripe_invents_later")).toBe(false);
    expect(grantsPaidAccess("")).toBe(false);
  });
});

describe("getPlan (Phase 12B status-gated resolution)", () => {
  async function makeUserOnPlan(planSlug: string, status: string): Promise<string> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: planSlug } });
    const user = await prisma.user.create({
      data: { email: `status-${planSlug}-${status}-${Date.now()}@example.com`, passwordHash: "x" },
    });
    await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status } });
    return user.id;
  }
  const disposableIds: string[] = [];
  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { userId: { in: disposableIds } } });
    await prisma.user.deleteMany({ where: { id: { in: disposableIds } } });
  });

  it("Q: an active Pro subscription grants Pro", async () => {
    const userId = await makeUserOnPlan("pro", "active");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("pro");
  });

  it("R: an active Basic subscription grants Basic", async () => {
    const userId = await makeUserOnPlan("basic", "active");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("basic");
  });

  it("U: a past_due Pro subscription RETAINS Pro access (locked decision #5)", async () => {
    const userId = await makeUserOnPlan("pro", "past_due");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("pro");
  });

  it("V: an unpaid Pro subscription falls back to Free (locked decision #7)", async () => {
    const userId = await makeUserOnPlan("pro", "unpaid");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("free");
  });

  it("S: a canceled Pro subscription falls back to Free (locked decision #8)", async () => {
    const userId = await makeUserOnPlan("pro", "canceled");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("free");
  });

  it("W: an incomplete Pro subscription falls back to Free", async () => {
    const userId = await makeUserOnPlan("pro", "incomplete");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("free");
  });

  it("X: an incomplete_expired Pro subscription falls back to Free", async () => {
    const userId = await makeUserOnPlan("pro", "incomplete_expired");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("free");
  });

  it("AZ: an unrecognized future status falls back to Free rather than granting access", async () => {
    const userId = await makeUserOnPlan("pro", "some_future_status");
    disposableIds.push(userId);
    expect((await getPlan(userId)).slug).toBe("free");
  });

  it("T: cancel_at_period_end + status still active retains paid access (locked decision #9)", async () => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } });
    const user = await prisma.user.create({
      data: { email: `status-cancel-scheduled-${Date.now()}@example.com`, passwordHash: "x" },
    });
    disposableIds.push(user.id);
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    expect((await getPlan(user.id)).slug).toBe("pro");
  });
});
