import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for POST /api/billing/checkout and POST
 * /api/billing/portal — both gated by consumer-session authentication
 * (getCurrentUser() -> next/headers's cookies()), which only works inside
 * a real Next.js request. Mirrors test/sourceProfileAdmin.integration.test.ts's
 * own established pattern of faking next/headers's cookies() with an
 * in-memory jar so the REAL route handlers (auth, CSRF, validation, the
 * actual Prisma/provider calls) all run for real.
 */
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
import { createSession } from "@/lib/auth/consumer/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { CSRF_HEADER } from "@/lib/auth/consumer/csrf";
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
    data: { slug: "test-billing-routes", name: "Test Billing Routes", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(() => {
  state.jar.clear();
  mockGetRuntimeBilling.mockReset();
});

async function signInAsFreshUser(
  planSlug: "free" | "basic" | "pro" = "free",
  externalCustomerId: string | null = null,
) {
  userCounter += 1;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { slug: planSlug } });
  const user = await prisma.user.create({
    data: {
      email: `route-${userCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
      externalCustomerId,
    },
  });
  await prisma.subscription.create({
    data: { userId: user.id, planId: plan.id, status: "active" },
  });
  disposableUserIds.push(user.id);
  const session = await createSession(user.id);
  state.jar.set(SESSION_COOKIE_NAME, session.token);
  return user.id;
}

function req(body?: unknown, extraHeaders?: Record<string, string>) {
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function authedReq(body?: unknown) {
  return req(body, { [CSRF_HEADER]: "1" });
}

describe("checkout route — CSRF and authentication", () => {
  it("J: rejects a request missing the CSRF header, even from a signed-in user", async () => {
    await signInAsFreshUser();
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(req({ plan: "basic" }));
    expect(res.status).toBe(403);
  });

  it("F: rejects an unauthenticated request", async () => {
    state.jar.clear();
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(authedReq({ plan: "basic" }));
    expect(res.status).toBe(401);
  });
});

describe("checkout route — plan validation and trusted resolution", () => {
  it("D: rejects an arbitrary plan value", async () => {
    await signInAsFreshUser();
    mockGetRuntimeBilling.mockReturnValue({
      enabled: true,
      provider: createMockBillingProvider(),
      config,
    });
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(authedReq({ plan: "enterprise" }));
    expect(res.status).toBe(400);
  });

  it("returns a checkout URL for a valid plan, using the CURRENT signed-in user's identity", async () => {
    const userId = await signInAsFreshUser();
    const provider = createMockBillingProvider();
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(authedReq({ plan: "pro" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(provider.state.customerCalls[0]!.veriqenUserId).toBe(userId);
  });

  it("BB: rejects checkout for an already-paid user with 409", async () => {
    await signInAsFreshUser("pro");
    mockGetRuntimeBilling.mockReturnValue({
      enabled: true,
      provider: createMockBillingProvider(),
      config,
    });
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(authedReq({ plan: "pro" }));
    expect(res.status).toBe(409);
  });

  it("BE: returns 503 when billing is not configured", async () => {
    await signInAsFreshUser();
    mockGetRuntimeBilling.mockReturnValue({ enabled: false, reason: "not configured" });
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(authedReq({ plan: "pro" }));
    expect(res.status).toBe(503);
  });
});

describe("portal route — CSRF, authentication, and ownership", () => {
  it("rejects a request missing the CSRF header", async () => {
    await signInAsFreshUser("pro", "cus_portal_owner");
    const { POST } = await import("@/app/api/billing/portal/route");
    const portalReq = new Request("http://localhost/api/billing/portal", { method: "POST" });
    const res = await POST(portalReq);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    state.jar.clear();
    const { POST } = await import("@/app/api/billing/portal/route");
    const portalReq = new Request("http://localhost/api/billing/portal", {
      method: "POST",
      headers: { [CSRF_HEADER]: "1" },
    });
    const res = await POST(portalReq);
    expect(res.status).toBe(401);
  });

  it("Y/Z: creates a portal session using ONLY the signed-in user's own stored customer id", async () => {
    await signInAsFreshUser("pro", "cus_portal_owner_2");
    const provider = createMockBillingProvider();
    mockGetRuntimeBilling.mockReturnValue({ enabled: true, provider, config });
    const { POST } = await import("@/app/api/billing/portal/route");
    const portalReq = new Request("http://localhost/api/billing/portal", {
      method: "POST",
      headers: { [CSRF_HEADER]: "1" },
    });
    const res = await POST(portalReq);
    expect(res.status).toBe(200);
    expect(provider.state.portalCalls).toEqual([{ customerId: "cus_portal_owner_2" }]);
  });

  it("a user with no billing account yet gets a clean 400, never a crash", async () => {
    await signInAsFreshUser("free", null);
    mockGetRuntimeBilling.mockReturnValue({
      enabled: true,
      provider: createMockBillingProvider(),
      config,
    });
    const { POST } = await import("@/app/api/billing/portal/route");
    const portalReq = new Request("http://localhost/api/billing/portal", {
      method: "POST",
      headers: { [CSRF_HEADER]: "1" },
    });
    const res = await POST(portalReq);
    expect(res.status).toBe(400);
  });
});
