import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getHealth } from "@/app/api/health/route";

/**
 * Phase 14B — L3: /api/health is public and unauthenticated. On a DB
 * failure it must never echo the raw exception (which can carry
 * hostnames, ports, connection-string fragments, internal paths) into the
 * HTTP response body — only a generic status, with the real detail logged
 * server-side only.
 */
afterEach(() => vi.restoreAllMocks());

describe("healthy path", () => {
  it("returns ok with no error field when the DB check succeeds", async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("message");
  });
});

describe("DB failure with secret-shaped/internal-path exception text", () => {
  const SENSITIVE_MESSAGES = [
    "connect ECONNREFUSED 10.0.4.12:5432",
    'password authentication failed for user "opennews" (host=internal-db.prod.local)',
    "/opt/opennews/prisma/schema.prisma: permission denied",
    "STRIPE_SECRET_KEY=sk_live_should_never_appear_here",
  ];

  for (const message of SENSITIVE_MESSAGES) {
    it(`never includes "${message.slice(0, 30)}..." in the public response body`, async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error(message));

      const res = await getHealth();
      const bodyText = await res.text();

      expect(res.status).toBe(503);
      expect(bodyText).not.toContain(message);
      expect(bodyText).toBe(JSON.stringify({ status: "error" }));

      // The real detail is still available server-side, for operators —
      // just never in the response a public, unauthenticated caller sees.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedArgs = errorSpy.mock.calls[0]!;
      expect(loggedArgs.some((arg) => arg instanceof Error && arg.message === message)).toBe(true);
    });
  }

  it("also degrades safely for a non-Error thrown value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce("a plain string rejection, not an Error");

    const res = await getHealth();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toEqual({ status: "error" });
  });
});
