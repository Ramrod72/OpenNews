import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { resolveViewerAdEligibility } from "@/lib/ads";
import { can } from "@/lib/entitlements";

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
    prisma.user.create({ data: { email: "free-ads@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "basic-ads@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "pro-ads@example.com", passwordHash: "x" } }),
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

describe("ad eligibility via the centralized entitlement system", () => {
  it("anonymous (null) resolves to Free's ads_enabled — ads allowed", async () => {
    expect(await can(null, "ads_enabled")).toBe(true);
  });

  it("Free: ads allowed", async () => {
    expect(await can(freeUserId, "ads_enabled")).toBe(true);
  });

  it("Basic: ads NOT allowed", async () => {
    expect(await can(basicUserId, "ads_enabled")).toBe(false);
  });

  it("Pro: ads NOT allowed", async () => {
    expect(await can(proUserId, "ads_enabled")).toBe(false);
  });

  it("a plan missing the ads_enabled entitlement row entirely fails closed (no ads), not open", async () => {
    const bareplan = await prisma.plan.create({
      data: { slug: "ads-entitlement-missing-test", name: "Bare Plan Test", priceCents: 0 },
    });
    const bareUser = await prisma.user.create({
      data: { email: "bare-plan-ads@example.com", passwordHash: "x" },
    });
    await prisma.subscription.create({
      data: { userId: bareUser.id, planId: bareplan.id, status: "active" },
    });

    try {
      expect(await can(bareUser.id, "ads_enabled")).toBe(false);
    } finally {
      await prisma.subscription.deleteMany({ where: { userId: bareUser.id } });
      await prisma.user.delete({ where: { id: bareUser.id } });
      await prisma.plan.delete({ where: { id: bareplan.id } });
    }
  });
});

describe("resolveViewerAdEligibility", () => {
  it("passes through the real check's result on success", async () => {
    expect(await resolveViewerAdEligibility(freeUserId)).toBe(true);
    expect(await resolveViewerAdEligibility(basicUserId)).toBe(false);
    expect(await resolveViewerAdEligibility(proUserId)).toBe(false);
    expect(await resolveViewerAdEligibility(null)).toBe(true);
  });

  it("anonymous (userId null) fails OPEN (normal Free behavior) if the check throws", async () => {
    const throwingCheck = async () => {
      throw new Error("simulated database outage");
    };
    expect(await resolveViewerAdEligibility(null, throwingCheck)).toBe(true);
  });

  it("an authenticated viewer fails CLOSED (no ads) if the check throws — protects the paid promise", async () => {
    const throwingCheck = async () => {
      throw new Error("simulated database outage");
    };
    expect(await resolveViewerAdEligibility(proUserId, throwingCheck)).toBe(false);
    expect(await resolveViewerAdEligibility(freeUserId, throwingCheck)).toBe(false);
  });
});
