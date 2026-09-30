import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 14B — H3: fetchAndParseFeed() must re-validate every redirect
 * target through the same public-http(s)/private-IP/credential guard as
 * the initial URL, never trusting Node's automatic `redirect: "follow"`.
 *
 * These tests run entirely offline against a local HTTP server standing in
 * for "a legitimate public feed origin" (avoiding any dependency on real
 * outbound network access or DNS). assertPublicHttpUrl is partially
 * mocked so that ONLY requests to this test server's own base URL are
 * treated as public; every other URL (representing an attacker-chosen
 * redirect target, including other addresses on 127.0.0.1) goes through
 * the REAL, unmocked implementation, which correctly rejects
 * loopback/private/link-local addresses, "localhost", non-http(s)
 * schemes, and embedded credentials entirely on its own -- no actual
 * private server is ever needed at those targets.
 */
const state = vi.hoisted(() => ({ origin: "" }));

vi.mock("@/lib/security/url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/url")>();
  return {
    ...actual,
    assertPublicHttpUrl: async (rawUrl: string) => {
      if (state.origin && rawUrl.startsWith(`${state.origin}/`)) {
        return new URL(rawUrl);
      }
      return actual.assertPublicHttpUrl(rawUrl);
    },
  };
});

import { fetchAndParseFeed, FeedFetchError } from "@/lib/ingest/fetchFeed";

const VALID_FEED_XML =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
  "<item><title>Item</title><link>https://example.com/a</link></item></channel></rss>";

// A fixed loopback address distinct from our own test server's actual port,
// so it never accidentally matches the bypass prefix above.
const PRIVATE_TARGET = "http://127.0.0.1:9/private";

let server: http.Server;

function redirectHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", state.origin || "http://127.0.0.1");

  if (url.pathname === "/feed") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(VALID_FEED_XML);
    return;
  }
  if (url.pathname === "/redirect-to") {
    const to = url.searchParams.get("to");
    const status = Number(url.searchParams.get("status") ?? "302");
    res.writeHead(status, to ? { location: to } : {});
    res.end();
    return;
  }
  if (url.pathname === "/redirect-no-location") {
    res.writeHead(302, {});
    res.end();
    return;
  }
  if (url.pathname === "/redirect-relative") {
    res.writeHead(302, { location: "/feed" });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-to-public-then-feed") {
    res.writeHead(302, { location: `${state.origin}/feed` });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-to-public-then-private") {
    res.writeHead(302, {
      location: `${state.origin}/redirect-to?to=${encodeURIComponent(PRIVATE_TARGET)}`,
    });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-loop-a") {
    res.writeHead(302, { location: `${state.origin}/redirect-loop-b` });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-loop-b") {
    res.writeHead(302, { location: `${state.origin}/redirect-loop-a` });
    res.end();
    return;
  }
  // A strictly-increasing chain, six hops long -- one more than
  // MAX_REDIRECTS -- so the cap is proven to trigger even without a true
  // cycle.
  const chainMatch = /^\/redirect-chain-(\d)$/.exec(url.pathname);
  if (chainMatch) {
    const n = Number(chainMatch[1]);
    if (n >= 6) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(VALID_FEED_XML);
    } else {
      res.writeHead(302, { location: `${state.origin}/redirect-chain-${n + 1}` });
      res.end();
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = http.createServer(redirectHandler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("baseline: a normal, non-redirecting fetch still works", () => {
  it("fetches and parses a plain feed with no redirect involved", async () => {
    const result = await fetchAndParseFeed(`${state.origin}/feed`);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("Item");
  });
});

describe("public -> private redirect", () => {
  it("rejects a redirect to a loopback address", async () => {
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to?to=${encodeURIComponent(PRIVATE_TARGET)}`),
    ).rejects.toThrow(FeedFetchError);
  });

  it("rejects a redirect to an RFC1918 private address (10.x)", async () => {
    await expect(
      fetchAndParseFeed(
        `${state.origin}/redirect-to?to=${encodeURIComponent("http://10.0.0.5/x")}`,
      ),
    ).rejects.toThrow(FeedFetchError);
  });

  it("rejects a redirect to an RFC1918 private address (192.168.x)", async () => {
    await expect(
      fetchAndParseFeed(
        `${state.origin}/redirect-to?to=${encodeURIComponent("http://192.168.1.1/x")}`,
      ),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("public -> localhost redirect", () => {
  it("rejects a redirect to the literal hostname 'localhost'", async () => {
    await expect(
      fetchAndParseFeed(
        `${state.origin}/redirect-to?to=${encodeURIComponent("http://localhost/x")}`,
      ),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("public -> cloud metadata redirect", () => {
  it("rejects a redirect to the link-local cloud metadata address", async () => {
    const target = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to?to=${encodeURIComponent(target)}`),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("public -> IPv6 private redirect", () => {
  it("rejects a redirect to the IPv6 loopback address", async () => {
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to?to=${encodeURIComponent("http://[::1]/x")}`),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("public -> public redirect", () => {
  it("follows a single redirect between two public-looking URLs and parses the result", async () => {
    const result = await fetchAndParseFeed(`${state.origin}/redirect-to-public-then-feed`);
    expect(result.items).toHaveLength(1);
  });
});

describe("multi-hop public redirects", () => {
  it("follows a chain of public redirects up to the cap and still succeeds when it terminates within it", async () => {
    // 5 redirects (chain-1..chain-5), 6th response is the real feed --
    // exactly at MAX_REDIRECTS, must still succeed.
    const result = await fetchAndParseFeed(`${state.origin}/redirect-chain-1`);
    expect(result.items).toHaveLength(1);
  });
});

describe("public -> public -> private", () => {
  it("rejects a private target reached via an intermediate public hop", async () => {
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to-public-then-private`),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("relative redirect", () => {
  it("resolves a relative Location header against the current URL before validating it", async () => {
    const result = await fetchAndParseFeed(`${state.origin}/redirect-relative`);
    expect(result.items).toHaveLength(1);
  });
});

describe("redirect loop", () => {
  it("gives up with a bounded FeedFetchError rather than looping forever", async () => {
    await expect(fetchAndParseFeed(`${state.origin}/redirect-loop-a`)).rejects.toThrow(
      FeedFetchError,
    );
  });
});

describe("too many redirects", () => {
  it("rejects a chain one hop longer than the cap even with no cycle at all", async () => {
    // Starting one step further back so termination would need 6 redirects
    // (chain-0 -> chain-1 -> ... -> chain-6's 200), one more than allowed.
    await expect(fetchAndParseFeed(`${state.origin}/redirect-chain-0`)).rejects.toThrow(
      /too many redirects/i,
    );
  });
});

describe("malformed Location", () => {
  it("fails safely when a redirect response has no Location header at all", async () => {
    await expect(fetchAndParseFeed(`${state.origin}/redirect-no-location`)).rejects.toThrow(
      /Location/i,
    );
  });
});

describe("non-http(s) Location", () => {
  it("rejects a redirect to a javascript: URL", async () => {
    await expect(
      fetchAndParseFeed(
        `${state.origin}/redirect-to?to=${encodeURIComponent("javascript:alert(1)")}`,
      ),
    ).rejects.toThrow(FeedFetchError);
  });

  it("rejects a redirect to a non-http(s) scheme like ftp:", async () => {
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to?to=${encodeURIComponent("ftp://8.8.8.8/x")}`),
    ).rejects.toThrow(FeedFetchError);
  });
});

describe("credential-bearing redirect", () => {
  it("rejects a redirect target with embedded userinfo, even against an otherwise-public IP", async () => {
    const target = "http://attacker:password@8.8.8.8/x";
    await expect(
      fetchAndParseFeed(`${state.origin}/redirect-to?to=${encodeURIComponent(target)}`),
    ).rejects.toThrow(FeedFetchError);
  });
});
