import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { resetRateLimitForTests } from "@/lib/rateLimit";
import { resetGlobalAdminLoginRateLimitForTests } from "@/lib/adminLoginRateLimit";
import { POST as postRegister } from "@/app/api/account/register/route";
import { POST as postLogin } from "@/app/api/account/login/route";
import { POST as postAdminLogin } from "@/app/api/admin/login/route";
import { CSRF_HEADER as ACCOUNT_CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";

/**
 * Phase 14B — H2: end-to-end proof that the corrected clientIp() (rightmost
 * X-Forwarded-For entry, never the leftmost/client-supplied one) actually
 * closes the rate-limit bypass Phase 14A found, across every real route
 * that keys a limiter off client IP, plus the new registration
 * process-global backstop.
 */

function accountReq(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/account/whatever", {
    method: "POST",
    headers: { "content-type": "application/json", [ACCOUNT_CSRF_HEADER]: "1", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function adminLoginReq(password: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ password }),
  });
}

function spoofedForwardedFor(realIp: string, fakeLeftmostPrefixLength: number): string {
  const fakeHops = Array.from({ length: fakeLeftmostPrefixLength }, (_, i) => `10.0.0.${i}`);
  return [...fakeHops, realIp].join(", ");
}

const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
});

beforeEach(() => {
  resetRateLimitForTests();
  resetGlobalAdminLoginRateLimitForTests();
});

afterEach(async () => {
  resetRateLimitForTests();
  resetGlobalAdminLoginRateLimitForTests();
  delete process.env.ADMIN_PASSWORD;
  if (disposableUserIds.length > 0) {
    await prisma.usageRecord.deleteMany({ where: { userId: { in: disposableUserIds } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: disposableUserIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
    disposableUserIds.length = 0;
  }
});

describe("consumer login: rotating a spoofed leftmost X-Forwarded-For entry no longer bypasses the per-IP bucket", () => {
  it("11 attempts, each with a distinct fake leftmost prefix but the SAME real (rightmost) IP, still trip the per-IP limiter at #11", async () => {
    const realIp = "203.0.113.77";
    let last;
    for (let i = 0; i < 11; i++) {
      last = await postLogin(
        accountReq(
          { email: "nonexistent-rotation-test@example.com", password: "whatever-wrong" },
          { "x-forwarded-for": spoofedForwardedFor(realIp, i) },
        ),
      );
    }
    expect(last!.status).toBe(429);
  });

  it("the per-email limiter still bounds brute force even when the (correctly-resolved) IP changes on every request", async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await postLogin(
        accountReq(
          { email: "single-target-account@example.com", password: "whatever-wrong" },
          { "x-forwarded-for": `203.0.113.${i}` }, // a genuinely different real IP each time
        ),
      );
    }
    expect(last!.status).toBe(429);
  });
});

describe("admin login: rotating a spoofed leftmost X-Forwarded-For entry no longer bypasses the per-IP bucket", () => {
  it("11 attempts, each with a distinct fake leftmost prefix but the SAME real (rightmost) IP, still trip the per-IP limiter at #11", async () => {
    process.env.ADMIN_PASSWORD = "correct-password-for-this-test";
    const realIp = "198.51.100.201";
    let last;
    for (let i = 0; i < 11; i++) {
      last = await postAdminLogin(
        adminLoginReq("wrong-password", { "x-forwarded-for": spoofedForwardedFor(realIp, i) }),
      );
    }
    expect(last!.status).toBe(429);
  });

  it("the process-global admin-login limiter still functions independently of the per-IP fix (unlimited distinct real IPs, 31st attempt blocked)", async () => {
    process.env.ADMIN_PASSWORD = "correct-password-for-this-test";
    let last;
    for (let i = 0; i < 31; i++) {
      last = await postAdminLogin(
        adminLoginReq("wrong-password", { "x-forwarded-for": `203.0.113.${i}` }),
      );
    }
    expect(last!.status).toBe(429);
  });

  it("a legitimate single-hop proxy value (well-formed, no spoofed prefix) still allows a correct login through", async () => {
    process.env.ADMIN_PASSWORD = "correct-password-for-this-test";
    const res = await postAdminLogin(
      adminLoginReq("correct-password-for-this-test", { "x-forwarded-for": "203.0.113.50" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("registration: process-global backstop bounds abuse an IP-rotating attacker would otherwise face zero throttling on", () => {
  it("50 filler attempts across 50 distinct spoofed IPs exhaust the global bucket; a 51st attempt from yet another new IP is still blocked", async () => {
    for (let i = 0; i < 50; i++) {
      // Intentionally invalid body (fails zod validation) -- the rate
      // limiter runs before body validation, so this cheaply exercises
      // the counter without creating 50 real users or paying bcrypt's cost
      // 50 times over.
      await postRegister(accountReq({}, { "x-forwarded-for": `10.9.9.${i}` }));
    }

    const email = `phase14b-global-backstop-${Date.now()}@example.com`;
    const res = await postRegister(
      accountReq(
        { email, password: "a-genuinely-long-enough-password" },
        { "x-forwarded-for": "10.9.9.250" }, // yet another brand-new "IP"
      ),
    );
    expect(res.status).toBe(429);

    const created = await prisma.user.findUnique({ where: { email } });
    expect(created).toBeNull();
  });

  it("legitimate, well-under-the-global-cap registrations from distinct real IPs still succeed", async () => {
    const email = `phase14b-legit-registration-${Date.now()}@example.com`;
    const res = await postRegister(
      accountReq(
        { email, password: "a-genuinely-long-enough-password" },
        { "x-forwarded-for": "203.0.113.201" },
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    disposableUserIds.push(body.user.id);
  });
});

describe("legitimate proxy forwarding is unaffected by the fix", () => {
  it("a normal, single-hop X-Forwarded-For value lets a real user log in without being mistaken for an attack", async () => {
    const email = `phase14b-legit-login-${Date.now()}@example.com`;
    const registerRes = await postRegister(
      accountReq(
        { email, password: "a-genuinely-long-enough-password" },
        { "x-forwarded-for": "203.0.113.202" },
      ),
    );
    expect(registerRes.status).toBe(201);
    const registered = await registerRes.json();
    disposableUserIds.push(registered.user.id);

    const loginRes = await postLogin(
      accountReq(
        { email, password: "a-genuinely-long-enough-password" },
        { "x-forwarded-for": "203.0.113.202" },
      ),
    );
    expect(loginRes.status).toBe(200);
  });
});
