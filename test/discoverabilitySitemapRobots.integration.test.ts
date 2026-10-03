import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getSiteUrl } from "@/lib/siteUrl";
import sitemap, { revalidate as sitemapRevalidate } from "@/app/sitemap";
import robots from "@/app/robots";

let categoryId: string;
let categorySlug: string;
let indexableSourceId: string;
let sparseSourceId: string;
let clusterId: string;
let clusterSlug: string;
let clusterLastUpdatedAt: Date;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: {
      slug: "test-discoverability-sitemap",
      name: "Test Discoverability Sitemap",
      order: 999,
    },
  });
  categoryId = category.id;
  categorySlug = category.slug;

  const indexableSource = await prisma.source.create({
    data: {
      name: "Sitemap Test Daily",
      url: "https://sitemap-test-daily.example.com/feed.xml",
      categorySlug: category.slug,
      description: "A synthetic publisher used only for sitemap tests.",
    },
  });
  indexableSourceId = indexableSource.id;

  // No description, no assessments — a sparse profile that must be
  // excluded from the sitemap (see isSourceProfileIndexable).
  const sparseSource = await prisma.source.create({
    data: {
      name: "Sitemap Test Sparse Wire",
      url: "https://sitemap-test-sparse.example.com/feed.xml",
      categorySlug: category.slug,
    },
  });
  sparseSourceId = sparseSource.id;

  clusterLastUpdatedAt = new Date("2026-01-15T00:00:00Z");
  const cluster = await prisma.storyCluster.create({
    data: {
      headline: "Sitemap test headline",
      slug: `test-discoverability-sitemap-${Math.random().toString(36).slice(2)}`,
      categoryId,
      firstSeenAt: new Date("2026-01-14T00:00:00Z"),
      lastUpdatedAt: clusterLastUpdatedAt,
      sourceCount: 1,
      articleCount: 1,
    },
  });
  clusterId = cluster.id;
  clusterSlug = cluster.slug;
});

afterAll(async () => {
  await prisma.storyCluster.delete({ where: { id: clusterId } });
  await prisma.source.deleteMany({ where: { id: { in: [indexableSourceId, sparseSourceId] } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

describe("sitemap() route segment config", () => {
  it("exports a revalidate interval, so this route is never permanently frozen to build-time data", () => {
    // Without this export, Next treats sitemap() as a plain static route
    // (no recognized dynamic API usage) and prerenders it once at `next
    // build` — which, in this project's Docker build, runs against an
    // intentionally empty placeholder database (DATABASE_URL=file:./
    // build-placeholder.db). That would permanently exclude every
    // category/source/story URL from the shipped sitemap. A finite,
    // positive revalidate value is what makes Next re-run sitemap()
    // against the real database after the interval elapses.
    expect(typeof sitemapRevalidate).toBe("number");
    expect(sitemapRevalidate).toBeGreaterThan(0);
    expect(Number.isFinite(sitemapRevalidate)).toBe(true);
  });
});

describe("sitemap()", () => {
  it("includes every static public route", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    const siteUrl = getSiteUrl();
    for (const path of ["/", "/about", "/pricing", "/sources", "/latest", "/breaking", "/search"]) {
      expect(urls).toContain(`${siteUrl}${path}`);
    }
  });

  it("includes the seeded category, with no fabricated lastModified", async () => {
    const entries = await sitemap();
    const entry = entries.find((e) => e.url === `${getSiteUrl()}/category/${categorySlug}`);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("lastModified");
  });

  it("includes the seeded story cluster with its real lastUpdatedAt", async () => {
    const entries = await sitemap();
    const entry = entries.find(
      (e) => e.url === `${getSiteUrl()}/story/${encodeURIComponent(clusterSlug)}`,
    );
    expect(entry).toBeDefined();
    expect(entry!.lastModified).toEqual(clusterLastUpdatedAt);
  });

  it("includes an indexable source profile but excludes a sparse one", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain(`${getSiteUrl()}/sources/${indexableSourceId}`);
    expect(urls).not.toContain(`${getSiteUrl()}/sources/${sparseSourceId}`);
  });

  it("never includes a private, admin, or API route", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    for (const forbidden of ["/account", "/bookmarks", "/login", "/register", "/admin", "/api"]) {
      expect(urls.some((u) => u.includes(forbidden))).toBe(false);
    }
  });
});

describe("robots()", () => {
  it("allows ordinary crawling by default", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules?.allow).toBe("/");
  });

  it("disallows every private/admin/API route", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = rules?.disallow;
    const disallowList = Array.isArray(disallow) ? disallow : [disallow];
    for (const path of ["/account", "/bookmarks", "/login", "/register", "/admin", "/api"]) {
      expect(disallowList).toContain(path);
    }
  });

  it("never disallows _next, static assets, or any rendering-required path", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = rules?.disallow;
    const disallowList = (Array.isArray(disallow) ? disallow : [disallow]).filter(
      Boolean,
    ) as string[];
    for (const entry of disallowList) {
      expect(entry.startsWith("/_next")).toBe(false);
    }
  });

  it("points at the real sitemap URL", () => {
    const result = robots();
    expect(result.sitemap).toBe(`${getSiteUrl()}/sitemap.xml`);
  });
});
