import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { parsePage } from "@/app/category/[slug]/page";
import { listStoryClustersByPage } from "@/lib/stories";

// Values that must never reach Prisma as a page/offset: unsafe integers
// (beyond Number.MAX_SAFE_INTEGER), non-finite, non-integer, or
// non-positive. Number.MAX_SAFE_INTEGER itself (9007199254740991) is the
// boundary — one past it (9007199254740992) is the first unsafe value.
const UNSAFE_OR_INVALID: Array<[label: string, raw: string]> = [
  ["zero", "0"],
  ["negative", "-1"],
  ["fractional", "1.5"],
  ["non-numeric", "abc"],
  ["scientific-notation astronomical", "1e21"],
  ["one past MAX_SAFE_INTEGER", "9007199254740992"],
];

describe("parsePage rejects unsafe/invalid page values, falling back to 1", () => {
  it.each(UNSAFE_OR_INVALID)("raw=%s (%s) -> 1", (_label, raw) => {
    expect(parsePage(raw)).toBe(1);
  });

  it("undefined -> 1 (no page param)", () => {
    expect(parsePage(undefined)).toBe(1);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["99999", 99999],
  ])("raw=%s is a safe positive integer and passes through unchanged", (raw, expected) => {
    expect(parsePage(raw)).toBe(expected);
  });

  it("Number.MAX_SAFE_INTEGER itself is accepted (it IS safe)", () => {
    expect(parsePage(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("listStoryClustersByPage: defense-in-depth against an unsafe `page` even if a future caller forgets to sanitize", () => {
  let categoryId: string;
  let categorySlug: string;
  const clusterIds: string[] = [];

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: {
        slug: "test-pagination-integer-safety",
        name: "Test Pagination Integer Safety",
        order: 999,
      },
    });
    categoryId = category.id;
    categorySlug = category.slug;

    for (let i = 0; i < 3; i++) {
      const cluster = await prisma.storyCluster.create({
        data: {
          headline: `Integer safety test ${i}`,
          slug: `test-pagination-integer-safety-${i}-${Math.random().toString(36).slice(2)}`,
          categoryId,
          firstSeenAt: new Date(),
          lastUpdatedAt: new Date(Date.now() - i * 1000),
          sourceCount: 1,
          articleCount: 1,
        },
      });
      clusterIds.push(cluster.id);
    }
  });

  afterAll(async () => {
    await prisma.storyCluster.deleteMany({ where: { id: { in: clusterIds } } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  // Every case here is called directly against the data-access function
  // with the RAW, unsanitized numeric value (bypassing parsePage/the
  // route entirely) — proving this function itself, not just its one
  // current caller, can never hand Prisma an unsafe skip.
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["1e21", 1e21],
    ["one past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ])("page=%s never throws and falls back to page 1's results", async (_label, rawPage) => {
    const result = await listStoryClustersByPage({
      categorySlug,
      page: rawPage,
      pageSize: 2,
    });
    expect(result.page).toBe(1);
    expect(result.clusters).toHaveLength(2);
  });

  it("page=1 and page=2 return different, non-overlapping clusters (deterministic ordering)", async () => {
    const page1 = await listStoryClustersByPage({ categorySlug, page: 1, pageSize: 2 });
    const page2 = await listStoryClustersByPage({ categorySlug, page: 2, pageSize: 2 });
    const page1Ids = page1.clusters.map((c) => c.id);
    const page2Ids = page2.clusters.map((c) => c.id);
    expect(page1Ids).toHaveLength(2);
    expect(page2Ids).toHaveLength(1);
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
  });

  it("an out-of-range but safe page (99999) returns an empty result, not an error", async () => {
    const result = await listStoryClustersByPage({ categorySlug, page: 99999, pageSize: 2 });
    expect(result.clusters).toHaveLength(0);
    expect(result.page).toBe(99999);
    expect(result.totalPages).toBeLessThan(99999);
  });

  it("Number.MAX_SAFE_INTEGER itself does not throw (the boundary is accepted, just produces an empty, safely-404-able page)", async () => {
    const result = await listStoryClustersByPage({
      categorySlug,
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 2,
    });
    expect(result.clusters).toHaveLength(0);
    expect(result.page).toBe(Number.MAX_SAFE_INTEGER);
  });
});
