import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSiteUrl, normalizeSiteUrl } from "./siteUrl";

describe("normalizeSiteUrl", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeSiteUrl("https://veriqen.example.com/")).toBe("https://veriqen.example.com");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeSiteUrl("https://veriqen.example.com///")).toBe("https://veriqen.example.com");
  });

  it("leaves a URL with no trailing slash unchanged", () => {
    expect(normalizeSiteUrl("https://veriqen.example.com")).toBe("https://veriqen.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSiteUrl("  https://veriqen.example.com/  ")).toBe(
      "https://veriqen.example.com",
    );
  });

  it("does not touch a path's internal slashes, only the trailing ones", () => {
    expect(normalizeSiteUrl("https://veriqen.example.com/foo/bar/")).toBe(
      "https://veriqen.example.com/foo/bar",
    );
  });
});

describe("getSiteUrl", () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = original;
  });

  it("falls back to http://localhost:3000 when NEXT_PUBLIC_SITE_URL is unset", () => {
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("falls back to the dev origin when NEXT_PUBLIC_SITE_URL is an empty string", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("falls back to the dev origin when NEXT_PUBLIC_SITE_URL is whitespace-only", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "   ";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("uses the configured production origin when set", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com";
    expect(getSiteUrl()).toBe("https://veriqen.example.com");
  });

  it("normalizes a configured origin's trailing slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com/";
    expect(getSiteUrl()).toBe("https://veriqen.example.com");
  });

  it("accepts a plain http:// origin (not forced to https)", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://veriqen.example.com";
    expect(getSiteUrl()).toBe("http://veriqen.example.com");
  });

  it("preserves an unusual port", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com:8443";
    expect(getSiteUrl()).toBe("https://veriqen.example.com:8443");
  });

  it("strips a path accidentally included in the configured origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com/some/path";
    expect(getSiteUrl()).toBe("https://veriqen.example.com");
  });

  it("strips a query string accidentally included in the configured origin, rather than letting it corrupt every story URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com?utm_source=newsletter";
    expect(getSiteUrl()).toBe("https://veriqen.example.com");
  });

  it("strips a fragment accidentally included in the configured origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com#section";
    expect(getSiteUrl()).toBe("https://veriqen.example.com");
  });

  it("falls back to the dev origin (never throws) for an unparseable value", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "not a url";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a javascript: scheme and falls back", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "javascript:alert(1)";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a data: scheme and falls back", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "data:text/html,<script>alert(1)</script>";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a file: scheme and falls back", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "file:///etc/passwd";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a URL carrying embedded credentials and falls back", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://user:pass@example.com";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a deceptive userinfo-based URL (looks like one host, resolves to another) and falls back", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://trusted-looking@evil.example";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("the value returned always survives new URL() — the one thing metadataBase requires — for every case above", () => {
    const values = [
      undefined,
      "",
      "   ",
      "https://veriqen.example.com",
      "http://veriqen.example.com",
      "https://veriqen.example.com:8443",
      "https://veriqen.example.com/some/path",
      "https://veriqen.example.com?utm=1",
      "https://veriqen.example.com#frag",
      "not a url",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://user:pass@example.com",
    ];
    for (const value of values) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = value;
      expect(() => new URL(getSiteUrl())).not.toThrow();
    }
  });

  it("a query/fragment-corrupted configured origin no longer swallows the /story/slug suffix once run through getStoryUrl", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://veriqen.example.com?utm=1";
    const { getStoryUrl } = await import("./share");
    const url = new URL(getStoryUrl("my-slug"));
    expect(url.pathname).toBe("/story/my-slug");
    expect(url.search).toBe("");
  });
});
