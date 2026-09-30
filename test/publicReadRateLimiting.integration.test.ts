import { afterEach, describe, expect, it } from "vitest";
import { resetRateLimitForTests } from "@/lib/rateLimit";
import { GET as getSearch } from "@/app/api/search/route";
import { GET as getStories } from "@/app/api/stories/route";
import { GET as getStory } from "@/app/api/stories/[slug]/route";

/**
 * Phase 14B — M4: the three most expensive public, unauthenticated
 * DB-backed read endpoints (search, story listing, single story) each get
 * a dedicated, tighter-than-the-general-API-limiter rate limit, keyed by
 * the corrected clientIp() (Phase 14B's H2 fix), so repeated requests
 * from a genuinely different IP are never conflated with one abusive
 * client.
 */
function reqWith(path: string, ip: string): Request {
  return new Request(`http://localhost${path}`, { headers: { "x-forwarded-for": ip } });
}

afterEach(() => resetRateLimitForTests());

describe("GET /api/search", () => {
  it("exhausts after 60 requests from one IP, returning a generic 429", async () => {
    const ip = "203.0.113.11";
    let last;
    for (let i = 0; i < 61; i++) {
      last = await getSearch(reqWith("/api/search?q=test", ip));
    }
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("a request within the limit still returns real search results (200)", async () => {
    const res = await getSearch(reqWith("/api/search?q=test", "203.0.113.12"));
    expect(res.status).toBe(200);
  });

  it("a distinct client IP has its own independent budget", async () => {
    const ipA = "203.0.113.21";
    const ipB = "203.0.113.22";
    for (let i = 0; i < 60; i++) {
      await getSearch(reqWith("/api/search?q=test", ipA));
    }
    // ipA is now at the edge of its own budget; ipB has never been seen.
    const resB = await getSearch(reqWith("/api/search?q=test", ipB));
    expect(resB.status).toBe(200);
  });

  it("resetRateLimitForTests clears the bucket deterministically", async () => {
    const ip = "203.0.113.31";
    for (let i = 0; i < 61; i++) {
      await getSearch(reqWith("/api/search?q=test", ip));
    }
    resetRateLimitForTests();
    const res = await getSearch(reqWith("/api/search?q=test", ip));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/stories", () => {
  it("exhausts after 60 requests from one IP, returning a generic 429", async () => {
    const ip = "203.0.113.41";
    let last;
    for (let i = 0; i < 61; i++) {
      last = await getStories(reqWith("/api/stories", ip));
    }
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("a distinct client IP has its own independent budget", async () => {
    const ipA = "203.0.113.51";
    const ipB = "203.0.113.52";
    for (let i = 0; i < 60; i++) {
      await getStories(reqWith("/api/stories", ipA));
    }
    const resB = await getStories(reqWith("/api/stories", ipB));
    expect(resB.status).toBe(200);
  });
});

describe("GET /api/stories/[slug]", () => {
  function paramsFor(slug: string) {
    return { params: Promise.resolve({ slug }) };
  }

  it("exhausts after 60 requests from one IP, returning a generic 429", async () => {
    const ip = "203.0.113.61";
    let last;
    for (let i = 0; i < 61; i++) {
      last = await getStory(reqWith("/api/stories/whatever", ip), paramsFor("whatever"));
    }
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("a request within the limit still reaches the real handler (404 for an unknown slug, not 429)", async () => {
    const res = await getStory(
      reqWith("/api/stories/does-not-exist", "203.0.113.62"),
      paramsFor("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });

  it("a distinct client IP has its own independent budget", async () => {
    const ipA = "203.0.113.71";
    const ipB = "203.0.113.72";
    for (let i = 0; i < 60; i++) {
      await getStory(reqWith("/api/stories/x", ipA), paramsFor("x"));
    }
    const resB = await getStory(reqWith("/api/stories/x", ipB), paramsFor("x"));
    expect(resB.status).not.toBe(429);
  });
});

describe("rotating a spoofed leftmost X-Forwarded-For entry does not defeat these limiters", () => {
  it("11 requests with distinct fake leftmost prefixes but the same real (rightmost) IP still share one budget", async () => {
    const realIp = "198.51.100.90";
    let last;
    for (let i = 0; i < 61; i++) {
      const spoofed = `10.0.0.${i}, ${realIp}`;
      last = await getSearch(reqWith("/api/search?q=test", spoofed));
    }
    expect(last!.status).toBe(429);
  });
});
