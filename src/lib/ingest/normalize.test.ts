import { describe, expect, it } from "vitest";
import { hashUrl, jaccardSimilarity, normalizeTitle, normalizeUrl, titleTokens } from "./normalize";

describe("normalizeUrl", () => {
  it("strips tracking params but keeps meaningful query params", () => {
    const a = normalizeUrl("https://example.com/story?utm_source=twitter&id=42");
    expect(a).toBe("https://example.com/story?id=42");
  });

  it("strips the fragment and trailing slash", () => {
    expect(normalizeUrl("https://example.com/story/#section-2")).toBe("https://example.com/story");
  });

  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://Example.COM/Story")).toBe("https://example.com/Story");
  });

  it("produces the same normalized URL for syndication-tracked duplicates", () => {
    const a = normalizeUrl("https://news.example.com/a/story-1?utm_source=rss&utm_medium=feed");
    const b = normalizeUrl("https://news.example.com/a/story-1/");
    expect(a).toBe(b);
  });
});

describe("hashUrl", () => {
  it("is deterministic for the same input", () => {
    const url = "https://example.com/story";
    expect(hashUrl(url)).toBe(hashUrl(url));
  });

  it("differs for different URLs", () => {
    expect(hashUrl("https://example.com/a")).not.toBe(hashUrl("https://example.com/b"));
  });
});

describe("normalizeTitle", () => {
  it("lowercases, strips punctuation, and removes stopwords", () => {
    expect(normalizeTitle("The Senate Passes a New Bill After Debate")).toBe(
      "senate passes bill debate",
    );
  });

  it("handles accented characters", () => {
    expect(normalizeTitle("Café opens in Übercity")).toContain("cafe");
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical token sets", () => {
    const tokens = titleTokens(normalizeTitle("senate passes new bill"));
    expect(jaccardSimilarity(tokens, tokens)).toBe(1);
  });

  it("is 0 for disjoint token sets", () => {
    const a = titleTokens(normalizeTitle("senate passes bill"));
    const b = titleTokens(normalizeTitle("weather forecast rain tomorrow"));
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("is higher for more overlapping headlines about the same event", () => {
    const a = titleTokens(normalizeTitle("Senate passes major climate bill in late vote"));
    const b = titleTokens(normalizeTitle("Senate approves climate bill after late-night vote"));
    const c = titleTokens(normalizeTitle("Local bakery wins regional pastry award"));
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(jaccardSimilarity(a, c));
  });
});
