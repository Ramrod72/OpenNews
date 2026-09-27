import { describe, expect, it } from "vitest";
import { extractiveSummary } from "./extractive";
import type { Article, Source } from "@prisma/client";

function makeArticle(
  overrides: Partial<Article & { source: Source }>,
): Article & { source: Source } {
  return {
    id: "art_1",
    sourceId: "src_1",
    url: "https://example.com/a",
    urlHash: "hash1",
    title: "Example headline",
    titleNormalized: "example headline",
    excerpt: null,
    imageUrl: null,
    author: null,
    categoryId: null,
    publishedAt: new Date(),
    fetchedAt: new Date(),
    guid: null,
    clusterId: null,
    createdAt: new Date(),
    source: {
      id: "src_1",
      name: "Example News",
      url: "https://example.com/feed",
      homepageUrl: null,
      categorySlug: "world",
      logoUrl: null,
      active: true,
      fetchIntervalMinutes: 30,
      lastFetchedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: null,
      sourceType: null,
      country: null,
      ownership: null,
      foundedYear: null,
      profileUpdatedAt: null,
    },
    ...overrides,
  };
}

describe("extractiveSummary", () => {
  it("returns an empty string when there are no articles", () => {
    expect(extractiveSummary({ headline: "Test", articles: [] })).toBe("");
  });

  it("never invents text — uses only the lead excerpt and source names", () => {
    const articles = [
      makeArticle({
        id: "1",
        excerpt: "Officials confirmed the update this morning.",
        source: { ...makeArticle({}).source, id: "s1", name: "Source A" },
      }),
      makeArticle({
        id: "2",
        excerpt: "A separate report added more detail.",
        source: { ...makeArticle({}).source, id: "s2", name: "Source B" },
      }),
    ];
    const summary = extractiveSummary({ headline: "Story", articles });
    expect(summary).toContain("Source A");
    expect(summary).toContain("Source B");
    expect(summary).toContain("Officials confirmed the update this morning.");
  });

  it("mentions covering sources only when there is more than one", () => {
    const single = [makeArticle({ excerpt: "Some detail." })];
    const summary = extractiveSummary({ headline: "Story", articles: single });
    expect(summary).not.toMatch(/^Covered by/);
  });
});
