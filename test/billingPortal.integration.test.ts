import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { createPortalForUser } from "@/lib/billing/portal";
import { createMockBillingProvider } from "@/lib/billing/testing/mockProvider";

let categoryId: string;
let userCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-billing-portal", name: "Test Billing Portal", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

async function makeUser(externalCustomerId: string | null): Promise<string> {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } });
  const user = await prisma.user.create({
    data: {
      email: `portal-${userCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
      externalCustomerId,
    },
  });
  await prisma.subscription.create({
    data: { userId: user.id, planId: plan.id, status: "active" },
  });
  disposableUserIds.push(user.id);
  return user.id;
}

describe("Y/Z: portal customer id comes only from the authenticated owner's own DB row", () => {
  it("creates a portal session for the user's own stored customer id", async () => {
    const userId = await makeUser("cus_real_owner");
    const provider = createMockBillingProvider();
    const result = await createPortalForUser(prisma, provider, { userId });
    expect(result.status).toBe("ok");
    expect(provider.state.portalCalls).toEqual([{ customerId: "cus_real_owner" }]);
  });

  it("Z: there is no parameter this function accepts that could point it at another user's customer — the customer id is looked up server-side by userId only", async () => {
    const ownerA = await makeUser("cus_owner_a");
    const ownerB = await makeUser("cus_owner_b");
    const provider = createMockBillingProvider();

    await createPortalForUser(prisma, provider, { userId: ownerA });
    await createPortalForUser(prisma, provider, { userId: ownerB });

    expect(provider.state.portalCalls).toEqual([
      { customerId: "cus_owner_a" },
      { customerId: "cus_owner_b" },
    ]);
  });
});

describe("missing/deleted customer fails safely", () => {
  it("a user who never checked out (no externalCustomerId) gets a clear 'no billing account' outcome, never a crash", async () => {
    const userId = await makeUser(null);
    const provider = createMockBillingProvider();
    const result = await createPortalForUser(prisma, provider, { userId });
    expect(result).toEqual({ status: "no_customer" });
    expect(provider.state.portalCalls).toHaveLength(0);
  });

  it("a provider-side failure (e.g. the customer was deleted directly in the Stripe dashboard) fails closed to 'unavailable'", async () => {
    const userId = await makeUser("cus_since_deleted");
    const provider = createMockBillingProvider({ portalFailure: "not_found" });
    const result = await createPortalForUser(prisma, provider, { userId });
    expect(result).toEqual({ status: "unavailable" });
  });
});
