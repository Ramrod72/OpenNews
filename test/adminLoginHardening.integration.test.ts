import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 13B — admin login/auth hardening: the new process-global
 * admin-login rate limiter (layered on the existing per-IP one), plus
 * regression coverage proving the existing auth/CSRF/isolation
 * guarantees still hold for the ONE genuinely new route surface this
 * phase adds (the /admin/operations page, gated by the same middleware
 * as every other /admin page) and for the settings route this phase
 * extended. Mirrors test/sourceProfileAdmin.integration.test.ts's own
 * established next/headers-mocking pattern for anything that goes
 * through getAdminSession()/cookies().
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

import { prisma } from "@/lib/db";
import { getAdminSession } from "@/lib/auth/session";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { PATCH as patchCategory } from "@/app/api/admin/categories/route";
import { PUT as putSettings } from "@/app/api/admin/settings/route";
import { POST as postLogin } from "@/app/api/admin/login/route";
import { POST as postLogout } from "@/app/api/admin/logout/route";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";
import { createSession } from "@/lib/auth/consumer/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import {
  isGlobalAdminLoginRateLimited,
  resetGlobalAdminLoginRateLimitForTests,
} from "@/lib/adminLoginRateLimit";

async function signInAsAdmin() {
  const session = await getAdminSession();
  session.isAdmin = true;
  await session.save();
}

function req(method: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return new Request("http://localhost/api/admin/test", {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function authedReq(method: string, body?: unknown) {
  return req(method, body, { [CSRF_HEADER]: "1" });
}

let categoryId: string;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-admin-login-hardening", name: "Test Admin Login Hardening", order: 999 },
  });
  categoryId = category.id;
});

afterEach(() => {
  state.jar.clear();
});

describe("1-4: authorization on the settings route (extended this phase)", () => {
  it("1: unauthenticated request is rejected", async () => {
    const res = await putSettings(authedReq("PUT", { ai: { storyBriefEnabled: true } }));
    expect(res.status).toBe(401);
  });

  it("2: a consumer session (not an admin session) cannot satisfy admin auth", async () => {
    const user = await prisma.user.create({
      data: { email: `login-hardening-${Date.now()}@example.com`, passwordHash: "x" },
    });
    disposableUserIds.push(user.id);
    const consumerSession = await createSession(user.id);
    // Presented under the CONSUMER cookie name — the admin route only
    // ever reads the admin cookie name, so this proves the two are
    // structurally incapable of colliding, not just that this one value
    // happens to fail.
    state.jar.set(SESSION_COOKIE_NAME, consumerSession.token);
    const res = await putSettings(authedReq("PUT", { ai: { storyBriefEnabled: true } }));
    expect(res.status).toBe(401);
  });

  it("3: a tampered/invalid admin session cookie is rejected", async () => {
    state.jar.set("opennews_admin_session", "not-a-valid-iron-session-payload");
    const res = await putSettings(authedReq("PUT", { ai: { storyBriefEnabled: true } }));
    expect(res.status).toBe(401);
  });

  it("4: logout invalidates the session for a subsequent request", async () => {
    await signInAsAdmin();
    const ok = await putSettings(authedReq("PUT", { ai: { storyBriefEnabled: true } }));
    expect(ok.status).toBe(200);

    await postLogout();
    const afterLogout = await putSettings(authedReq("PUT", { ai: { storyBriefEnabled: false } }));
    expect(afterLogout.status).toBe(401);
  });
});

describe("1: unauthenticated access to the new /admin/operations page is rejected by middleware", () => {
  it("redirects to /admin/login, mirroring every other protected admin page", async () => {
    const request = new NextRequest("http://localhost/admin/operations");
    const res = await proxy(request);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });
});

describe("5/6/7/8: login rate limiting", () => {
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD_HASH;
    resetGlobalAdminLoginRateLimitForTests();
  });

  function loginReq(password: string, ip: string) {
    return new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ password }),
    });
  }

  it("5: the existing per-IP limiter still functions (11th attempt from one IP -> 429)", async () => {
    process.env.ADMIN_PASSWORD = "correct-password";
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    resetGlobalAdminLoginRateLimitForTests();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await postLogin(loginReq("wrong", ip));
    }
    expect(last!.status).toBe(429);
  });

  it("6: the new global limiter activates once its threshold is reached, even across DIFFERENT IPs", async () => {
    process.env.ADMIN_PASSWORD = "correct-password";
    resetGlobalAdminLoginRateLimitForTests();
    let last;
    // 31 attempts, each from a UNIQUE IP — the per-IP limiter (10/IP)
    // never trips because no IP is reused, isolating the global limiter
    // (30/window) as the one thing that can still reject request 31.
    for (let i = 0; i < 31; i++) {
      last = await postLogin(loginReq("wrong", `203.0.113.${i}`));
    }
    expect(last!.status).toBe(429);
  });

  it("7: successful login still works normally when under both limits", async () => {
    process.env.ADMIN_PASSWORD = "correct-password";
    resetGlobalAdminLoginRateLimitForTests();
    const ip = `198.51.100.${Math.floor(Math.random() * 50) + 1}`;
    const res = await postLogin(loginReq("correct-password", ip));
    expect(res.status).toBe(200);
  });

  it("8: the limiter does not alter password-verification response semantics (still generic, no near-miss hint)", async () => {
    process.env.ADMIN_PASSWORD = "correct-password";
    resetGlobalAdminLoginRateLimitForTests();
    const ip = `198.51.100.${Math.floor(Math.random() * 50) + 100}`;
    const wrong = await postLogin(loginReq("correct-passwore", ip)); // one char off
    const veryWrong = await postLogin(loginReq("totally-different", ip));
    const wrongBody = await wrong.json();
    const veryWrongBody = await veryWrong.json();
    expect(wrong.status).toBe(401);
    expect(veryWrong.status).toBe(401);
    expect(wrongBody.error).toBe(veryWrongBody.error); // identical generic message either way
  });

  it("the global limiter's own helper is deterministic and resettable for tests", () => {
    resetGlobalAdminLoginRateLimitForTests();
    const now = Date.now();
    for (let i = 0; i < 29; i++) {
      expect(isGlobalAdminLoginRateLimited(now)).toBe(false);
    }
    expect(isGlobalAdminLoginRateLimited(now)).toBe(false); // 30th, still allowed
    expect(isGlobalAdminLoginRateLimited(now)).toBe(true); // 31st, rejected
    resetGlobalAdminLoginRateLimitForTests();
    expect(isGlobalAdminLoginRateLimited(now)).toBe(false); // reset clears it
  });
});

describe("9-11: CSRF on the category route", () => {
  it("9: mutation without the CSRF header is rejected", async () => {
    await signInAsAdmin();
    const category = await prisma.category.findUniqueOrThrow({ where: { id: categoryId } });
    const res = await patchCategory(req("PATCH", { id: category.id, order: 1 }));
    expect(res.status).toBe(403);
  });

  it("10: a request with an unrelated header (not the CSRF one) is still rejected", async () => {
    await signInAsAdmin();
    const category = await prisma.category.findUniqueOrThrow({ where: { id: categoryId } });
    const res = await patchCategory(
      req("PATCH", { id: category.id, order: 1 }, { "x-something-else": "1" }),
    );
    expect(res.status).toBe(403);
  });

  it("11: the correct CSRF header proceeds to the actual mutation", async () => {
    await signInAsAdmin();
    const category = await prisma.category.findUniqueOrThrow({ where: { id: categoryId } });
    const res = await patchCategory(authedReq("PATCH", { id: category.id, order: 2 }));
    expect(res.status).toBe(200);
  });
});
