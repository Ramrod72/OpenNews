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
});
