import { afterEach, describe, expect, it, vi } from "vitest";
import { sealData, unsealData } from "iron-session";

/**
 * Phase 14B — H1: production SESSION_SECRET must fail closed.
 *
 * Covers both the pure config-building function (getSessionOptions) and
 * the two real request paths that depend on it: the /admin/* middleware
 * guard (proxy.ts) and the admin login route, which must never hand out a
 * working admin session sealed with the known, publicly-visible
 * development fallback secret while running in production.
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

import { getSessionOptions } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";
import { POST as postLogin } from "@/app/api/admin/login/route";
import { resetGlobalAdminLoginRateLimitForTests } from "@/lib/adminLoginRateLimit";

// The exact string baked into sessionOptions.ts as its development-only
// fallback — public in this open-source repository, so it must never be
// usable as a real production signing key.
const KNOWN_DEV_FALLBACK_SECRET = "dev-only-insecure-secret-please-set-SESSION_SECRET-xxxxxxxxxxxx";
const REAL_PRODUCTION_SECRET = "a-real-32-char-plus-production-secret-value";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;

afterEach(() => {
  // NODE_ENV is typed read-only by @types/node, so it's stubbed/restored via
  // vi.stubEnv/vi.unstubAllEnvs rather than direct assignment.
  vi.unstubAllEnvs();
  if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SECRET;
  state.jar.clear();
  resetGlobalAdminLoginRateLimitForTests();
});

describe("A: production + missing secret => rejected/fails closed", () => {
  it("getSessionOptions() throws rather than returning any password", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    expect(() => getSessionOptions()).toThrow();
  });

  it("proxy's admin guard returns a generic 500, never a working session, for a protected admin path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    const res = await proxy(new NextRequest("http://localhost/admin/sources"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("SESSION_SECRET");
  });

  it("the admin login route rejects even when the correct password is supplied — there is no session to hand out", async () => {
    process.env.ADMIN_PASSWORD = "correct-password-for-this-test";
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    await expect(
      postLogin(
        new Request("http://localhost/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "correct-password-for-this-test" }),
        }),
      ),
    ).rejects.toThrow();
    delete process.env.ADMIN_PASSWORD;
  });
});

describe("B: production + empty secret => rejected", () => {
  it("getSessionOptions() throws for an empty string secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = "";
    expect(() => getSessionOptions()).toThrow();
  });

  it("getSessionOptions() throws for a secret shorter than 32 characters", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = "too-short-to-be-a-real-secret";
    expect(process.env.SESSION_SECRET.length).toBeLessThan(32);
    expect(() => getSessionOptions()).toThrow();
  });
});

describe("C: production + valid secret => accepted", () => {
  it("getSessionOptions() returns the configured secret, never the fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = REAL_PRODUCTION_SECRET;
    expect(REAL_PRODUCTION_SECRET.length).toBeGreaterThanOrEqual(32);
    const options = getSessionOptions();
    expect(options.password).toBe(REAL_PRODUCTION_SECRET);
    expect(options.password).not.toBe(KNOWN_DEV_FALLBACK_SECRET);
  });

  it("cookieOptions.secure is true and admin login succeeds end to end", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = REAL_PRODUCTION_SECRET;
    process.env.ADMIN_PASSWORD = "correct-password-for-this-test";
    const options = getSessionOptions();
    expect(options.cookieOptions?.secure).toBe(true);

    const res = await postLogin(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-password-for-this-test" }),
      }),
    );
    expect(res.status).toBe(200);
    delete process.env.ADMIN_PASSWORD;
  });
});

describe("D: development/test behavior remains intentional", () => {
  it("a missing secret outside production uses the known dev fallback and never throws", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.SESSION_SECRET;
    expect(() => getSessionOptions()).not.toThrow();
    expect(getSessionOptions().password).toBe(KNOWN_DEV_FALLBACK_SECRET);
  });

  it("also true when NODE_ENV is entirely unset", () => {
    vi.stubEnv("NODE_ENV", undefined);
    delete process.env.SESSION_SECRET;
    expect(() => getSessionOptions()).not.toThrow();
  });

  it("a configured secret outside production is still honored (not forced to the fallback)", () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.SESSION_SECRET = REAL_PRODUCTION_SECRET;
    expect(getSessionOptions().password).toBe(REAL_PRODUCTION_SECRET);
  });
});

describe("E: no known fallback secret can forge a production admin session", () => {
  it("a cookie sealed with the known dev fallback secret never unseals to an admin session against a correctly configured production instance", async () => {
    const forgedSeal = await sealData(
      { isAdmin: true },
      { password: KNOWN_DEV_FALLBACK_SECRET, ttl: 0 },
    );

    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = REAL_PRODUCTION_SECRET;
    const options = getSessionOptions();

    // iron-session swallows an unseal failure (wrong key) internally and
    // resolves to {} rather than rejecting — this is the exact mechanism
    // src/proxy.ts's guardAdmin() and getAdminSession() rely on to treat a
    // mismatched-key cookie as "not authenticated" rather than crashing.
    const unsealed = await unsealData<{ isAdmin?: boolean }>(forgedSeal, {
      password: options.password,
      ttl: 0,
    });
    expect(unsealed.isAdmin).not.toBe(true);
  });

  it("production with a missing secret never reaches a state where any password (fallback or otherwise) is returned", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    let options;
    try {
      options = getSessionOptions();
    } catch {
      options = undefined;
    }
    expect(options).toBeUndefined();
  });

  it("proxy's admin guard, given a cookie forged with the known fallback secret, never treats it as authenticated in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_SECRET = REAL_PRODUCTION_SECRET;
    const forgedSeal = await sealData(
      { isAdmin: true },
      { password: KNOWN_DEV_FALLBACK_SECRET, ttl: 0 },
    );
    const request = new NextRequest("http://localhost/admin/sources", {
      headers: { cookie: `opennews_admin_session=${forgedSeal}` },
    });
    const res = await proxy(request);
    // Never a successful pass-through (200/next) — either a redirect to
    // login (unsealing silently failed to {}) or, if the seal library
    // rejects entirely, a 500. Both are "not authenticated".
    expect(res.status).not.toBe(200);
    if (res.status === 307 || res.status === 308) {
      expect(res.headers.get("location")).toContain("/admin/login");
    }
  });
});
