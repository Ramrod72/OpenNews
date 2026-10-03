import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getSiteUrl } from "@/lib/siteUrl";
import { generateMetadata as categoryMetadata } from "@/app/category/[slug]/page";
import { generateMetadata as sourceMetadata } from "@/app/sources/[id]/page";
import { generateMetadata as searchMetadata } from "@/app/search/page";
import { metadata as accountMetadata } from "@/app/account/page";
import { metadata as adminProtectedMetadata } from "@/app/admin/(protected)/layout";
import { metadata as loginMetadata } from "@/app/login/layout";
import { metadata as registerMetadata } from "@/app/register/layout";
import { metadata as bookmarksMetadata } from "@/app/bookmarks/layout";
import { metadata as adminLoginMetadata } from "@/app/admin/login/layout";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value as Record<string, unknown> | undefined;
}

describe("private routes are noindex via page/layout metadata, not just robots.txt", () => {
  it.each([
    ["account", accountMetadata],
    ["admin (protected) layout", adminProtectedMetadata],
    ["login", loginMetadata],
    ["register", registerMetadata],
    ["bookmarks", bookmarksMetadata],
    ["admin login", adminLoginMetadata],
  ])("%s sets robots.index to false", (_name, metadata) => {
    const robots = asRecord(asRecord(metadata)?.robots);
    expect(robots?.index).toBe(false);
  });
});

describe("generateMetadata for /category/[slug] pagination canonical", () => {
  let categoryId: string;
  let categorySlug: string;
  const clusterIds: string[] = [];

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: {
        slug: "test-discoverability-category",
        name: "Test Discoverability Category",
        order: 999,
      },
    });
    categoryId = category.id;
    categorySlug = category.slug;

    for (let i = 0; i < 3; i++) {
      const cluster = await prisma.storyCluster.create({
        data: {
          headline: `Category pagination test ${i}`,
          slug: `test-discoverability-category-${i}-${Math.random().toString(36).slice(2)}`,
          categoryId,
          firstSeenAt: new Date(),
          lastUpdatedAt: new Date(),
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
  });

  it("page 1 canonicalizes to the bare category URL", async () => {
    const metadata = await categoryMetadata({
      params: Promise.resolve({ slug: categorySlug }),
      searchParams: Promise.resolve({}),
    });
    const alternates = asRecord(metadata.alternates);
    expect(alternates?.canonical).toBe(`${getSiteUrl()}/category/${categorySlug}`);
  });

  it("page 2 canonicalizes to itself, never back to page 1", async () => {
    const metadata = await categoryMetadata({
      params: Promise.resolve({ slug: categorySlug }),
      searchParams: Promise.resolve({ page: "2" }),
    });
    const alternates = asRecord(metadata.alternates);
    expect(alternates?.canonical).toBe(`${getSiteUrl()}/category/${categorySlug}?page=2`);
  });

  it("an unknown category still returns a generic title rather than throwing", async () => {
    const metadata = await categoryMetadata({
      params: Promise.resolve({ slug: "does-not-exist" }),
      searchParams: Promise.resolve({}),
    });
    expect(metadata.title).toBe("Category");
  });
});

describe("generateMetadata for /sources/[id] sparse-profile noindex", () => {
  let categoryId: string;
  let completeSourceId: string;
  let sparseSourceId: string;

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: {
        slug: "test-discoverability-source",
        name: "Test Discoverability Source",
        order: 999,
      },
    });
    categoryId = category.id;

    const complete = await prisma.source.create({
      data: {
        name: "Metadata Test Complete Source",
        url: "https://metadata-test-complete.example.com/feed.xml",
        categorySlug: category.slug,
        description: "A genuine synthetic publisher description for this test.",
      },
    });
    completeSourceId = complete.id;

    const sparse = await prisma.source.create({
      data: {
        name: "Metadata Test Sparse Source",
        url: "https://metadata-test-sparse.example.com/feed.xml",
        categorySlug: category.slug,
      },
    });
    sparseSourceId = sparse.id;
  });

  afterAll(async () => {
    await prisma.source.deleteMany({ where: { id: { in: [completeSourceId, sparseSourceId] } } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  it("a complete profile has no robots override (stays indexable)", async () => {
    const metadata = await sourceMetadata({ params: Promise.resolve({ id: completeSourceId }) });
    expect(metadata.robots).toBeUndefined();
    const alternates = asRecord(metadata.alternates);
    expect(alternates?.canonical).toBe(`${getSiteUrl()}/sources/${completeSourceId}`);
  });

  it("a sparse profile is noindex, follow — but still has a canonical and a title (still accessible)", async () => {
    const metadata = await sourceMetadata({ params: Promise.resolve({ id: sparseSourceId }) });
    const robots = asRecord(metadata.robots);
    expect(robots?.index).toBe(false);
    expect(robots?.follow).toBe(true);
    expect(metadata.title).toBe("Metadata Test Sparse Source");
  });
});

describe("generateMetadata for /search indexing behavior", () => {
  it("the bare search page is indexable and canonicalizes to /search", async () => {
    const metadata = await searchMetadata({ searchParams: Promise.resolve({}) });
    const robots = asRecord(metadata.robots);
    expect(robots?.index).toBe(true);
    const alternates = asRecord(metadata.alternates);
    expect(alternates?.canonical).toBe(`${getSiteUrl()}/search`);
  });

  it.each([
    ["q", { q: "example" }],
    ["category", { category: "world" }],
    ["source", { source: "abc123" }],
    ["sort", { sort: "newest" }],
    ["from", { from: "2026-01-01" }],
    ["to", { to: "2026-01-31" }],
    ["page>1", { page: "2" }],
  ])(
    "a %s filter makes the page noindex, follow, canonicalizing back to bare /search",
    async (_label, params) => {
      const metadata = await searchMetadata({ searchParams: Promise.resolve(params) });
      const robots = asRecord(metadata.robots);
      expect(robots?.index).toBe(false);
      expect(robots?.follow).toBe(true);
      const alternates = asRecord(metadata.alternates);
      expect(alternates?.canonical).toBe(`${getSiteUrl()}/search`);
    },
  );

  it("page=1 explicitly is treated the same as no page param (still indexable)", async () => {
    const metadata = await searchMetadata({ searchParams: Promise.resolve({ page: "1" }) });
    const robots = asRecord(metadata.robots);
    expect(robots?.index).toBe(true);
  });
});
