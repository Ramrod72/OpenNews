import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { getAccountPlanSummary, getPricingView } from "@/lib/pricing";

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
    prisma.user.create({ data: { email: "free-pricing@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "basic-pricing@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "pro-pricing@example.com", passwordHash: "x" } }),
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
  await prisma.subscription.deleteMany({
    where: { userId: { in: [freeUserId, basicUserId, proUserId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [freeUserId, basicUserId, proUserId] } } });
  await prisma.$disconnect();
});

describe("getPricingView", () => {
  it("always returns exactly the three seeded plans, cheapest first, with the configured prices", async () => {
    const view = await getPricingView(null);
    expect(view.plans.map((p) => p.slug)).toEqual(["free", "basic", "pro"]);
    expect(view.plans.map((p) => p.priceCents)).toEqual([0, 499, 999]);
  });

  it("anonymous visitor: no plan is current, and every plan's CTA is 'signup'", async () => {
    const view = await getPricingView(null);
    expect(view.currentPlanSlug).toBeNull();
    for (const plan of view.plans) {
      expect(plan.isCurrent).toBe(false);
      expect(plan.cta).toBe("signup");
    }
  });

  it("Free account: Free is current, Basic and Pro show as upgrades", async () => {
    const view = await getPricingView(freeUserId);
    expect(view.currentPlanSlug).toBe("free");
    const bySlug = Object.fromEntries(view.plans.map((p) => [p.slug, p]));
    expect(bySlug.free.isCurrent).toBe(true);
    expect(bySlug.free.cta).toBe("current");
    expect(bySlug.basic.cta).toBe("upgrade");
    expect(bySlug.pro.cta).toBe("upgrade");
  });

  it("Basic account: Basic is current, Free is a lower tier (not an upgrade), Pro is an upgrade", async () => {
    const view = await getPricingView(basicUserId);
    const bySlug = Object.fromEntries(view.plans.map((p) => [p.slug, p]));
    expect(bySlug.basic.isCurrent).toBe(true);
    expect(bySlug.free.cta).toBe("lower-tier");
    expect(bySlug.pro.cta).toBe("upgrade");
  });

  it("Pro account: Pro is current, nothing is offered as an upgrade", async () => {
    const view = await getPricingView(proUserId);
    const bySlug = Object.fromEntries(view.plans.map((p) => [p.slug, p]));
    expect(bySlug.pro.isCurrent).toBe(true);
    expect(bySlug.free.cta).toBe("lower-tier");
    expect(bySlug.basic.cta).toBe("lower-tier");
    expect(view.plans.some((p) => p.cta === "upgrade")).toBe(false);
  });

  it("the comparison table's plan order matches the plan list", async () => {
    const view = await getPricingView(null);
    const adsRow = view.comparisonRows.find((r) => r.key === "ads_enabled");
    expect(adsRow!.cells).toHaveLength(3);
    expect(adsRow!.cells[0].included).toBe(false); // Free
    expect(adsRow!.cells[1].included).toBe(true); // Basic
  });
});

describe("getAccountPlanSummary", () => {
  it("Free user: current plan is Free, upgrade options are Basic and Pro", async () => {
    const summary = await getAccountPlanSummary(freeUserId);
    expect(summary.slug).toBe("free");
    const upgrades = summary.otherPlans.filter((p) => p.cta === "upgrade").map((p) => p.slug);
    expect(upgrades.sort()).toEqual(["basic", "pro"]);
  });

  it("Basic user: current plan is Basic, only Pro is an upgrade option", async () => {
    const summary = await getAccountPlanSummary(basicUserId);
    expect(summary.slug).toBe("basic");
    const upgrades = summary.otherPlans.filter((p) => p.cta === "upgrade").map((p) => p.slug);
    expect(upgrades).toEqual(["pro"]);
  });

  it("Pro user: current plan is Pro, no upgrade options, and AI usage is reported", async () => {
    const summary = await getAccountPlanSummary(proUserId);
    expect(summary.slug).toBe("pro");
    expect(summary.otherPlans.some((p) => p.cta === "upgrade")).toBe(false);
    expect(summary.aiUsage).toEqual({ allowed: true, used: 0, limit: 50 });
  });

  it("Free/Basic users have no AI quota, so no AI usage is reported", async () => {
    const freeSummary = await getAccountPlanSummary(freeUserId);
    const basicSummary = await getAccountPlanSummary(basicUserId);
    expect(freeSummary.aiUsage).toBeNull();
    expect(basicSummary.aiUsage).toBeNull();
  });

  it("Basic/Pro's included list shows unlimited saved stories, not a numeric limit", async () => {
    const summary = await getAccountPlanSummary(basicUserId);
    const labels = summary.highlights.map((h) => h.label);
    expect(labels).toContain("Unlimited saved stories");
  });

  it("a plan with an unlimited (null) AI quota still reports AI usage, not `null` — regression for the same ?? 0 bug the config-driven cases can't exercise (no seeded plan has a null ai_monthly_quota today)", async () => {
    const unlimitedPlan = await prisma.plan.create({
      data: { slug: "unlimited-ai-test", name: "Unlimited AI Test", priceCents: 1999 },
    });
    await prisma.entitlement.create({
      data: { planId: unlimitedPlan.id, feature: "ai_monthly_quota", limitValue: null },
    });
    const unlimitedUser = await prisma.user.create({
      data: { email: "unlimited-ai@example.com", passwordHash: "x" },
    });
    await prisma.subscription.create({
      data: { userId: unlimitedUser.id, planId: unlimitedPlan.id, status: "active" },
    });

    try {
      const summary = await getAccountPlanSummary(unlimitedUser.id);
      expect(summary.aiUsage).toEqual({ allowed: true, used: 0, limit: null });
    } finally {
      await prisma.subscription.deleteMany({ where: { userId: unlimitedUser.id } });
      await prisma.user.delete({ where: { id: unlimitedUser.id } });
      await prisma.entitlement.deleteMany({ where: { planId: unlimitedPlan.id } });
      await prisma.plan.delete({ where: { id: unlimitedPlan.id } });
    }
  });
});
