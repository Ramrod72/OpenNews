import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { resetRateLimitForTests } from "@/lib/rateLimit";

/**
 * Phase 14B — M5: the story page (/story/[slug]) has no API route of its
 * own to attach a rate limiter to — it's a server component — so
 * middleware (src/proxy.ts) gates it the same way it already gates
 * /api/* and /admin/*, before the page's expensive per-cluster
 * recomputation (loadStoryIntelligence/loadCoverageComparison/AI Story
 * Brief) ever runs. This is a request-rate protection only: it adds no
 * caching of any kind, so it cannot introduce cross-user/cross-entitlement
 * leakage by construction — the existing storyIntelligence/coverage
 * comparison/AI Story Brief test suites (unmodified by this change)
 * remain the proof that Free/Basic/Pro redaction is still correct.
 */
afterEach(() => resetRateLimitForTests());

describe("repeated abusive access to one story is bounded", () => {
  it("exhausts after 100 requests from one IP, returning a generic 429 before the page ever renders", async () => {
    const ip = "203.0.113.111";
    let last;
    for (let i = 0; i < 101; i++) {
      const req = new NextRequest("http://localhost/story/some-slug", {
        headers: { "x-forwarded-for": ip },
      });
      last = await proxy(req);
    }
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body).toEqual({ error: "Too many requests" });
  });
});

describe("independent clients / normal browsing", () => {
  it("a distinct client IP has its own independent budget", async () => {
    const ipA = "203.0.113.121";
    const ipB = "203.0.113.122";
    for (let i = 0; i < 100; i++) {
      await proxy(
        new NextRequest("http://localhost/story/some-slug", {
          headers: { "x-forwarded-for": ipA },
        }),
      );
    }
    const resB = await proxy(
      new NextRequest("http://localhost/story/some-slug", { headers: { "x-forwarded-for": ipB } }),
    );
    expect(resB.status).toBe(200);
  });

  it("a normal handful of story-page visits (well under the limit) passes through untouched", async () => {
    const ip = "203.0.113.131";
    for (let i = 0; i < 5; i++) {
      const res = await proxy(
        new NextRequest(`http://localhost/story/slug-${i}`, {
          headers: { "x-forwarded-for": ip },
        }),
      );
      expect(res.status).toBe(200);
    }
  });

  it("resetRateLimitForTests clears the bucket deterministically", async () => {
    const ip = "203.0.113.141";
    for (let i = 0; i < 101; i++) {
      await proxy(
        new NextRequest("http://localhost/story/some-slug", {
          headers: { "x-forwarded-for": ip },
        }),
      );
    }
    resetRateLimitForTests();
    const res = await proxy(
      new NextRequest("http://localhost/story/some-slug", { headers: { "x-forwarded-for": ip } }),
    );
    expect(res.status).toBe(200);
  });
});

describe("rotating a spoofed leftmost X-Forwarded-For entry does not defeat this limiter", () => {
  it("101 requests with distinct fake leftmost prefixes but the same real (rightmost) IP still share one budget", async () => {
    const realIp = "198.51.100.201";
    let last;
    for (let i = 0; i < 101; i++) {
      const req = new NextRequest("http://localhost/story/some-slug", {
        headers: { "x-forwarded-for": `10.0.0.${i}, ${realIp}` },
      });
      last = await proxy(req);
    }
    expect(last!.status).toBe(429);
  });
});

describe("other routes are unaffected", () => {
  it("a non-story path is never subject to the story-page-specific bucket", async () => {
    const ip = "203.0.113.151";
    // Exhaust the story-page bucket for this IP...
    for (let i = 0; i < 101; i++) {
      await proxy(
        new NextRequest("http://localhost/story/some-slug", {
          headers: { "x-forwarded-for": ip },
        }),
      );
    }
    // ...a request to an unrelated public page path is a completely
    // different bucket key and is unaffected.
    const res = await proxy(
      new NextRequest("http://localhost/category/world", { headers: { "x-forwarded-for": ip } }),
    );
    expect(res.status).toBe(200);
  });
});
