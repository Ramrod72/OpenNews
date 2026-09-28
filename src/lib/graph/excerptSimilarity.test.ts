import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_SIZE_FOR_TEXT_COMPARISON,
  MIN_WORDS_FOR_COMPARISON,
  NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
  excerptJaccardSimilarity,
  findNearDuplicatePairs,
} from "./excerptSimilarity";

describe("excerptJaccardSimilarity", () => {
  it("returns 1 for identical text", () => {
    expect(
      excerptJaccardSimilarity(
        "Reuters said the storm caused damage.",
        "Reuters said the storm caused damage.",
      ),
    ).toBe(1);
  });

  it("B — returns a low score for genuinely dissimilar excerpts", () => {
    const score = excerptJaccardSimilarity(
      "Reuters said the storm caused significant damage across the coastline.",
      "The city council approved a new budget for park renovations downtown.",
    );
    expect(score).toBeLessThan(NEAR_DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it("C — returns a high score for near-identical excerpts (minor rewording)", () => {
    const score = excerptJaccardSimilarity(
      "Reuters reported that the storm caused significant damage across the coastline today.",
      "Reuters reported that the storm caused significant damage across the coastline this morning.",
    );
    expect(score).toBeGreaterThanOrEqual(NEAR_DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it("is symmetric", () => {
    const a = "The quick brown fox jumps over the lazy dog near the river bank.";
    const b = "A quick brown fox jumped over a lazy dog by the river bank today.";
    expect(excerptJaccardSimilarity(a, b)).toBeCloseTo(excerptJaccardSimilarity(b, a), 10);
  });

  it("handles empty/whitespace-only input without throwing and returns 0", () => {
    expect(excerptJaccardSimilarity("", "some text here")).toBe(0);
    expect(excerptJaccardSimilarity("some text here", "")).toBe(0);
    expect(excerptJaccardSimilarity("   ", "   ")).toBe(0);
    expect(excerptJaccardSimilarity("", "")).toBe(0);
  });

  it("is case- and punctuation-insensitive", () => {
    const a = "Reuters said the deal was finalized on Monday.";
    const b = "REUTERS SAID THE DEAL WAS FINALIZED ON MONDAY!!!";
    expect(excerptJaccardSimilarity(a, b)).toBe(1);
  });
});

describe("findNearDuplicatePairs — short/degenerate excerpts never produce a false-positive match", () => {
  it("does not flag two coincidentally-identical short/boilerplate excerpts as near-duplicates", () => {
    // Below shingle size, a short excerpt collapses to one whole-text
    // "shingle" — two such short fragments that happen to be identical
    // (e.g. a malformed feed leaving only a placeholder) would otherwise
    // score a perfect 1.0 similarity from almost no real evidence.
    const pairs = findNearDuplicatePairs([
      { articleId: "a1", excerpt: "Breaking News" },
      { articleId: "a2", excerpt: "Breaking News" },
    ]);
    expect(pairs).toEqual([]);
  });

  it("still compares real excerpts right at MIN_WORDS_FOR_COMPARISON", () => {
    const words = Array.from({ length: MIN_WORDS_FOR_COMPARISON }, (_, i) => `word${i}`).join(" ");
    const pairs = findNearDuplicatePairs([
      { articleId: "a1", excerpt: words },
      { articleId: "a2", excerpt: words },
    ]);
    expect(pairs).toHaveLength(1);
  });

  it("excludes an excerpt one word short of MIN_WORDS_FOR_COMPARISON even if otherwise identical", () => {
    const words = Array.from({ length: MIN_WORDS_FOR_COMPARISON - 1 }, (_, i) => `word${i}`).join(
      " ",
    );
    const pairs = findNearDuplicatePairs([
      { articleId: "a1", excerpt: words },
      { articleId: "a2", excerpt: words },
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("findNearDuplicatePairs", () => {
  it("finds no pairs among mutually dissimilar excerpts", () => {
    const pairs = findNearDuplicatePairs([
      {
        articleId: "a1",
        excerpt: "Reuters said the storm caused significant damage across the coast.",
      },
      { articleId: "a2", excerpt: "The city council approved a new budget for park renovations." },
      { articleId: "a3", excerpt: "A local bakery won an award for its sourdough bread recipe." },
    ]);
    expect(pairs).toEqual([]);
  });

  it("finds a pair among near-identical excerpts", () => {
    const pairs = findNearDuplicatePairs([
      {
        articleId: "a1",
        excerpt: "Reuters reported the storm caused significant damage across the coastline today.",
      },
      {
        articleId: "a2",
        excerpt:
          "Reuters reported the storm caused significant damage across the coastline this morning.",
      },
      { articleId: "a3", excerpt: "A local bakery won an award for its sourdough bread recipe." },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.articleIdA).toBe("a1");
    expect(pairs[0]!.articleIdB).toBe("a2");
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(NEAR_DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it("ignores articles with no excerpt", () => {
    const pairs = findNearDuplicatePairs([
      { articleId: "a1", excerpt: "" },
      { articleId: "a2", excerpt: "" },
    ]);
    expect(pairs).toEqual([]);
  });

  it("O — performance guard: returns [] without comparing when the group exceeds MAX_GROUP_SIZE_FOR_TEXT_COMPARISON, staying fast even for a large group", () => {
    const large = Array.from({ length: MAX_GROUP_SIZE_FOR_TEXT_COMPARISON + 1 }, (_, i) => ({
      articleId: `a${i}`,
      excerpt: `Reuters reported update number ${i} about the ongoing situation today.`,
    }));

    const start = performance.now();
    const pairs = findNearDuplicatePairs(large);
    const elapsedMs = performance.now() - start;

    expect(pairs).toEqual([]);
    expect(elapsedMs).toBeLessThan(50);
  });

  it("still compares exhaustively (and can find multiple pairs) right at the cap boundary", () => {
    // 22 mutually-dissimilar filler topics (deliberately sharing little
    // vocabulary with each other) plus 3 near-identical Reuters excerpts —
    // 25 total, exactly at MAX_GROUP_SIZE_FOR_TEXT_COMPARISON.
    const fillerTopics = [
      "A local bakery won an award for its sourdough bread recipe.",
      "The city council approved a new budget for park renovations downtown.",
      "Scientists discovered a rare species of frog in a remote rainforest.",
      "The football team celebrated their championship victory with a parade.",
      "A new art exhibit opened featuring sculptures made from recycled metal.",
      "Farmers reported a strong harvest season despite early summer drought.",
      "The museum unveiled ancient pottery recovered from an archaeological dig.",
      "A tech startup launched a mobile app for tracking home energy usage.",
      "The orchestra performed a sold-out concert celebrating its anniversary.",
      "Volunteers cleaned up litter along the riverside walking trail yesterday.",
      "The airline announced new nonstop routes connecting several small airports.",
      "A university lab published findings on battery storage efficiency gains.",
      "The zoo welcomed two rare tiger cubs born earlier this spring season.",
      "Local chefs competed in a cooking contest featuring regional seafood dishes.",
      "The library expanded its collection with a grant for digital archives.",
      "A marathon drew thousands of runners through the historic downtown streets.",
      "The theater company announced its upcoming season of classic stage plays.",
      "Engineers completed repairs on the aging bridge ahead of the winter deadline.",
      "A charity raised funds for flood relief through a weekend bake sale event.",
      "The observatory hosted a public viewing night for the annual meteor shower.",
      "Students built a solar-powered vehicle for an international engineering contest.",
      "The vineyard celebrated a record grape harvest after a mild growing season.",
    ];
    expect(fillerTopics).toHaveLength(MAX_GROUP_SIZE_FOR_TEXT_COMPARISON - 3);

    const atCap = [
      {
        articleId: "r0",
        excerpt: "Reuters reported the storm caused significant damage across the coastline today.",
      },
      {
        articleId: "r1",
        excerpt:
          "Reuters reported the storm caused significant damage across the coastline this morning.",
      },
      {
        articleId: "r2",
        excerpt:
          "Reuters reported the storm caused significant damage across the coastline this week.",
      },
      ...fillerTopics.map((excerpt, i) => ({ articleId: `f${i}`, excerpt })),
    ];
    expect(atCap).toHaveLength(MAX_GROUP_SIZE_FOR_TEXT_COMPARISON);

    const pairs = findNearDuplicatePairs(atCap);
    // Only the 3 near-identical Reuters excerpts should pair up: (r0,r1), (r0,r2), (r1,r2).
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      expect(pair.articleIdA.startsWith("r")).toBe(true);
      expect(pair.articleIdB.startsWith("r")).toBe(true);
    }
  });
});
