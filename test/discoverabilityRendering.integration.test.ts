import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { EvidenceDrawer } from "@/components/story/EvidenceDrawer";
import SourcesPage from "@/app/sources/page";
import CategoryPage from "@/app/category/[slug]/page";
import SourceProfilePage from "@/app/sources/[id]/page";
import type { ReportingSourceGroupView } from "@/lib/storyIntelligenceView";

/** Extracts every {name, item} pair from the single BreadcrumbList JSON-LD script's itemListElement. */
function extractJsonLdBreadcrumbNames(html: string): string[] {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (!match) return [];
  for (const scriptTag of match) {
    const jsonText = scriptTag
      .replace(/^<script type="application\/ld\+json">/, "")
      .replace(/<\/script>$/, "");
    const parsed = JSON.parse(jsonText);
    if (parsed["@type"] === "BreadcrumbList") {
      return parsed.itemListElement.map((item: { name: string }) => item.name);
    }
  }
  return [];
}

/** Extracts the visible breadcrumb names from the <nav aria-label="Breadcrumb"> markup, in order. */
function extractVisibleBreadcrumbNames(html: string): string[] {
  const nav = html.match(/<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) return [];
  const names: string[] = [];
  const re = />([^<]+)<\/(?:a|span)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nav[1])) !== null) {
    names.push(m[1]);
  }
  return names;
}

describe("EvidenceDrawer renders provenance/source links into the initial HTML", () => {
  it("article and source-profile links are present in the static markup even though <details> starts collapsed", () => {
    const group: ReportingSourceGroupView = {
      key: "entity-1",
      entityName: "Example Wire Service",
      kind: "reporting_intermediary",
      articleCount: 1,
      articles: [
        {
          articleId: "article-1",
          title: "Example article title",
          url: "https://publisher.example.com/article-1",
          publisherName: "Example Daily",
          publisherSourceId: "source-1",
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(EvidenceDrawer, { reportingSourceGroups: [group], originalReporting: null }),
    );

    // The outer disclosure is a native <details> (no client JS needed to
    // reveal this), and it is NOT given an `open` attribute — exactly the
    // normal collapsed state — yet the link is still in the markup.
    expect(html).toMatch(/<details/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain('href="/sources/source-1"');
    expect(html).toContain("Example Daily");
    expect(html).toContain('href="https://publisher.example.com/article-1"');
    expect(html).toContain("Example article title");
  });

  it("renders nothing at all when there is no content (not an empty shell)", () => {
    const html = renderToStaticMarkup(
      createElement(EvidenceDrawer, { reportingSourceGroups: [], originalReporting: null }),
    );
    expect(html).toBe("");
  });

  it("is no longer a Client Component — no 'use client' directive", () => {
    const source = readFileSync(
      join(__dirname, "..", "src/components/story/EvidenceDrawer.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/^"use client";/m);
  });
});

describe("/sources links each source name to its own internal profile page", () => {
  let categoryId: string;
  let sourceId: string;

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: { slug: "test-discoverability-sources-links", name: "Test Sources Links", order: 999 },
    });
    categoryId = category.id;

    const source = await prisma.source.create({
      data: {
        name: "Internal Linking Test Source",
        url: "https://internal-linking-test.example.com/feed.xml",
        categorySlug: category.slug,
        homepageUrl: "https://internal-linking-test.example.com",
      },
    });
    sourceId = source.id;
  });

  afterAll(async () => {
    await prisma.source.delete({ where: { id: sourceId } });
    await prisma.category.delete({ where: { id: categoryId } });
  });

  it("renders a real <a href> to /sources/[id] for every listed source, as a server-rendered link", async () => {
    const element = await SourcesPage();
    const html = renderToStaticMarkup(element);
    expect(html).toContain(`href="/sources/${sourceId}"`);
    expect(html).toContain("Internal Linking Test Source");
    // The external homepage link is preserved alongside it, not replaced.
    expect(html).toContain('href="https://internal-linking-test.example.com"');
  });
});

describe("/category/[slug] pagination is reachable through real, server-rendered links", () => {
  let categoryId: string;
  let categorySlug: string;
  const clusterIds: string[] = [];

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: {
        slug: "test-discoverability-category-links",
        name: "Test Category Links",
        order: 999,
      },
    });
    categoryId = category.id;
    categorySlug = category.slug;

    // 13 clusters at PAGE_SIZE=12 forces a genuine second page.
    for (let i = 0; i < 13; i++) {
      const cluster = await prisma.storyCluster.create({
        data: {
          headline: `Category link test ${i}`,
          slug: `test-discoverability-category-links-${i}-${Math.random().toString(36).slice(2)}`,
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
  });

  it("page 1 contains a real <a href> to page 2, not only a client-fetch button", async () => {
    const element = await CategoryPage({
      params: Promise.resolve({ slug: categorySlug }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(`href="/category/${categorySlug}?page=2"`);
  });

  it("page 2 actually renders the remaining story and links back to page 1 without a page param", async () => {
    const element = await CategoryPage({
      params: Promise.resolve({ slug: categorySlug }),
      searchParams: Promise.resolve({ page: "2" }),
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Category link test 12");
    expect(html).toContain(`href="/category/${categorySlug}"`);
  });
});

describe("visible breadcrumbs agree with their BreadcrumbList JSON-LD", () => {
  let categoryId: string;
  let categorySlug: string;
  let categoryName: string;
  let sourceId: string;
  let sourceName: string;

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: {
        slug: "test-discoverability-breadcrumbs",
        name: "Test Breadcrumbs Agreement",
        order: 999,
      },
    });
    categoryId = category.id;
    categorySlug = category.slug;
    categoryName = category.name;

    const source = await prisma.source.create({
      data: {
        name: "Breadcrumb Agreement Test Source",
        url: "https://breadcrumb-agreement-test.example.com/feed.xml",
        categorySlug: category.slug,
        description: "A synthetic publisher used only for this breadcrumb test.",
      },
    });
    sourceId = source.id;
    sourceName = source.name;
  });

  afterAll(async () => {
    await prisma.source.delete({ where: { id: sourceId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  it("/category/[slug]: visible trail and JSON-LD list the same names in the same order", async () => {
    const element = await CategoryPage({
      params: Promise.resolve({ slug: categorySlug }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);
    expect(extractVisibleBreadcrumbNames(html)).toEqual(["Home", categoryName]);
    expect(extractJsonLdBreadcrumbNames(html)).toEqual(["Home", categoryName]);
  });

  it("/sources/[id]: visible trail and JSON-LD list the same names in the same order", async () => {
    const element = await SourceProfilePage({ params: Promise.resolve({ id: sourceId }) });
    const html = renderToStaticMarkup(element);
    expect(extractVisibleBreadcrumbNames(html)).toEqual(["Home", "Sources", sourceName]);
    expect(extractJsonLdBreadcrumbNames(html)).toEqual(["Home", "Sources", sourceName]);
  });
});
