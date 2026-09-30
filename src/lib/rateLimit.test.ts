import { afterEach, describe, expect, it } from "vitest";
import { clientIp, isRateLimited, resetRateLimitForTests } from "./rateLimit";

/**
 * Phase 14B — H2: clientIp() must never trust client-supplied
 * X-Forwarded-For entries as the real peer address. These are pure unit
 * tests against the function itself; test/clientIpHardening.integration.test.ts
 * covers the same scenarios end-to-end through real routes.
 */
function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/whatever", { headers });
}

describe("clientIp: spoofed leftmost X-Forwarded-For is never trusted", () => {
  it("returns the rightmost entry, not the leftmost attacker-supplied one", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(ip).toBe("203.0.113.9");
    expect(ip).not.toBe("1.2.3.4");
  });

  it("an attacker prepending many fake hops still yields only the rightmost (proxy-appended) entry", () => {
    const fakeHops = Array.from({ length: 20 }, (_, i) => `10.0.0.${i}`).join(", ");
    const ip = clientIp(reqWith({ "x-forwarded-for": `${fakeHops}, 203.0.113.42` }));
    expect(ip).toBe("203.0.113.42");
  });
});

describe("clientIp: multi-hop X-Forwarded-For", () => {
  it("a two-hop chain still resolves to the last entry (the nearest trusted proxy's own view)", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "198.51.100.1, 203.0.113.5, 192.0.2.9" }));
    expect(ip).toBe("192.0.2.9");
  });
});

describe("clientIp: malformed X-Forwarded-For", () => {
  it('a trailing comma with an empty final hop is skipped, not returned as ""', () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.9," }));
    expect(ip).toBe("203.0.113.9");
  });

  it("an entirely empty header value degrades to the shared unknown bucket", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "" }));
    expect(ip).toBe("unknown");
  });

  it("a header of only commas/whitespace degrades to the shared unknown bucket", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": " , , " }));
    expect(ip).toBe("unknown");
  });
});

describe("clientIp: absent headers", () => {
  it('no X-Forwarded-For and no X-Real-IP returns "unknown"', () => {
    const ip = clientIp(new Request("http://localhost/whatever"));
    expect(ip).toBe("unknown");
  });
});

describe("clientIp: IPv4 and IPv6", () => {
  it("resolves a plain IPv4 rightmost entry", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("resolves an IPv6 rightmost entry without being confused by its colons", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 2001:db8::1" }));
    expect(ip).toBe("2001:db8::1");
  });

  it("resolves an IPv6 X-Real-IP value directly", () => {
    expect(clientIp(reqWith({ "x-real-ip": "2001:db8::abcd" }))).toBe("2001:db8::abcd");
  });
});

describe("clientIp: X-Real-IP takes precedence over X-Forwarded-For", () => {
  it("prefers X-Real-IP (the proxy's own overwritten value) when both headers are present", () => {
    const ip = clientIp(
      reqWith({ "x-real-ip": "203.0.113.55", "x-forwarded-for": "9.9.9.9, 8.8.8.8" }),
    );
    expect(ip).toBe("203.0.113.55");
  });

  it("an empty X-Real-IP falls through to X-Forwarded-For rather than being trusted as-is", () => {
    const ip = clientIp(reqWith({ "x-real-ip": "", "x-forwarded-for": "1.1.1.1, 203.0.113.55" }));
    expect(ip).toBe("203.0.113.55");
  });
});

describe("clientIp: legitimate single-hop proxy forwarding still works", () => {
  it("a well-behaved single-entry X-Forwarded-For (no prior client value) resolves correctly", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.99" }))).toBe("203.0.113.99");
  });
});

describe("clientIp: rotating spoofed values each produce a distinct (but still non-authoritative) bucket key", () => {
  it("rotating the untrusted leftmost hop while keeping the real rightmost hop fixed still buckets identically", () => {
    const ipA = clientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
    const ipB = clientIp(reqWith({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }));
    // The whole point of the fix: rotating the attacker-controlled prefix
    // does NOT change the resolved identity, so it can no longer be used
    // to defeat a per-IP rate limit by generating a "new" IP every request.
    expect(ipA).toBe(ipB);
  });
});

describe("isRateLimited + resetRateLimitForTests", () => {
  afterEach(() => resetRateLimitForTests());

  it("resetRateLimitForTests(key) clears exactly that bucket", () => {
    const key = `test-reset-${Date.now()}`;
    expect(isRateLimited(key, 1, 60_000)).toBe(false);
    expect(isRateLimited(key, 1, 60_000)).toBe(true);
    resetRateLimitForTests(key);
    expect(isRateLimited(key, 1, 60_000)).toBe(false);
  });
});
