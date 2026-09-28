import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import { loadStoryIntelligence } from "@/lib/storyIntelligence";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";
import { seedPlans } from "../prisma/seedPlans";
import type { AliasIndex } from "@/lib/provenance/entityResolution";
import type { StoryClusterCard } from "@/lib/stories";

/**
 * Phase 9B integration tests: loadStoryIntelligence against a real
 * (SQLite test) database, exercising the full path — real Prisma
 * queries, real Phase 7B extraction, real Phase 8 grouping, real
 * entitlement resolution — end to end.
 */

let categoryId: string;
let sourceId: string;
let aliasIndex: AliasIndex;
let freeUserId: string;
let basicUserId: string;
let proUserId: string;
let articleCounter = 0;

beforeAll(async () => {
  await seedProvenanceEntities(prisma);
  await seedPlans(prisma);
  aliasIndex = await loadAliasIndex(prisma);

  const category = await prisma.category.create({
    data: { slug: "test-story-intel", name: "Test Story Intel", order: 9999 },
  });
  categoryId = category.id;

  const source = await prisma.source.create({
    data: {
      name: "Test Story Intel Source",
      url: "https://story-intel-test.example.com/feed.xml",
      categorySlug: "test-story-intel",
    },
  });
  sourceId = source.id;

  const [freePlan, basicPlan, proPlan] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { slug: "free" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "basic" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } }),
  ]);
  const [freeUser, basicUser, proUser] = await Promise.all([
    prisma.user.create({ data: { email: "free-si@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "basic-si@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "pro-si@example.com", passwordHash: "x" } }),
  ]);
  freeUserId = freeUser.id;
  basicUserId = basicUser.id;
  proUserId = proUser.id;
  await Promise.all([
    prisma.subscription.create({
      data: { userId: freeUserId, planId: freePlan.id, status: "active" },
    }),
    prisma.subscription.create({
      data: { userId: basicUserId, planId: basicPlan.id, status: "active" },
    }),
    prisma.subscription.create({
      data: { userId: proUserId, planId: proPlan.id, status: "active" },
    }),
  ]);
});

afterAll(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.subscription.deleteMany({
    where: { userId: { in: [freeUserId, basicUserId, proUserId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [freeUserId, basicUserId, proUserId] } } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeCluster(): Promise<string> {
  articleCounter += 1;
  const cluster = await prisma.storyCluster.create({
    data: {
      headline: `Test story intel cluster ${articleCounter}`,
      slug: `test-story-intel-${articleCounter}-${Date.now()}`,
      categoryId,
      firstSeenAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  });
  return cluster.id;
}

async function makeArticle(clusterId: string | null, title?: string): Promise<string> {
  articleCounter += 1;
  const url = `https://story-intel-test.example.com/a${articleCounter}`;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url,
      urlHash: hashUrl(normalizeUrl(url)),
      title: title ?? `Story intel test article ${articleCounter}`,
      titleNormalized: `story intel test article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
      clusterId,
    },
  });
  return article.id;
}

/** Loads the exact StoryClusterCard shape loadStoryIntelligence expects, mirroring src/lib/stories.ts. */
async function loadClusterCard(clusterId: string): Promise<StoryClusterCard> {
  return prisma.storyCluster.findUniqueOrThrow({
    where: { id: clusterId },
    include: {
      category: true,
      articles: { orderBy: { publishedAt: "asc" }, include: { source: true } },
    },
  });
}

describe("N/O/P/Q — entitlement tiers", () => {
  it("Free user (N) and logged-out (Q) both get a preview: capped groups, no evidence", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the negotiations concluded successfully this morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    const cluster = await loadClusterCard(clusterId);

    for (const userId of [freeUserId, null]) {
      const result = await loadStoryIntelligence(cluster, userId);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.hasFullAccess).toBe(false);
      expect(result.reportingSourceGroups[0]?.articles).toBeUndefined();
      expect(result.reportingSourceGroups[0]?.evidence).toBeUndefined();
    }
  });

  it("Basic user (O) and Pro user (P) both get full drill-down via provenance_full", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the negotiations concluded successfully this morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    const cluster = await loadClusterCard(clusterId);

    for (const userId of [basicUserId, proUserId]) {
      const result = await loadStoryIntelligence(cluster, userId);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.hasFullAccess).toBe(true);
      expect(result.reportingSourceGroups[0]?.articles).toHaveLength(2);
      expect(result.reportingSourceGroups[0]?.evidence?.length).toBeGreaterThan(0);
    }
  });
});

describe("X — nonexistent cluster behavior unchanged (still fails closed, not thrown to the page)", () => {
  it("loadStoryIntelligence never throws for a since-deleted cluster id", async () => {
    const clusterId = await makeCluster();
    const cluster = await loadClusterCard(clusterId);
    await prisma.storyCluster.delete({ where: { id: clusterId } });

    const result = await loadStoryIntelligence(cluster, null);
    expect(result).toEqual({ status: "unavailable" });
  });
});

describe("Y — provenance failure does not break story-page rendering", () => {
  it("returns {status: unavailable} instead of throwing when the summary call fails", async () => {
    const clusterId = await makeCluster();
    const cluster = await loadClusterCard(clusterId);
    await prisma.storyCluster.delete({ where: { id: clusterId } }); // forces getClusterOriginSummary to throw

    await expect(loadStoryIntelligence(cluster, null)).resolves.toEqual({ status: "unavailable" });
  });

  it("never leaks an error message, stack trace, or internal detail in the returned shape", async () => {
    const clusterId = await makeCluster();
    const cluster = await loadClusterCard(clusterId);
    await prisma.storyCluster.delete({ where: { id: clusterId } });

    const result = await loadStoryIntelligence(cluster, null);
    expect(Object.keys(result)).toEqual(["status"]);
  });
});

describe("real end-to-end grouping (Reuters/AP/DOJ merged entity) matches Phase 8 semantics", () => {
  it("groups Reuters separately from AP, resolves a merged DOJ duplicate, and counts unresolved articles", async () => {
    const clusterId = await makeCluster();
    const r1 = await makeArticle(clusterId, "Reuters coverage one");
    const r2 = await makeArticle(clusterId, "Reuters coverage two");
    const ap1 = await makeArticle(clusterId, "AP coverage one");
    const ap2 = await makeArticle(clusterId, "AP coverage two");
    const unresolved = await makeArticle(clusterId, "Weather roundup");

    await persistObservationsForArticle(prisma, {
      articleId: r1,
      text: "Reuters reported the story broke overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: r2,
      text: "Reuters reported additional details this morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: ap1,
      text: "AP reported the mayor's office issued a statement.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: ap2,
      text: "AP reported additional comments from the mayor's office.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: unresolved,
      text: "The weather was pleasant across the region this week.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });

    const cluster = await loadClusterCard(clusterId);
    const result = await loadStoryIntelligence(cluster, proUserId);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");

    expect(result.articleCount).toBe(5);
    const names = result.reportingSourceGroups.map((g) => g.entityName).sort();
    expect(names).toEqual(["Associated Press", "Reuters"]);
    expect(result.sourcingNotDetectedCount).toBe(1);
  });
});

describe("no mutation / no network request from loadStoryIntelligence", () => {
  it("leaves row counts unchanged and never calls fetch", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Story Intel Source",
      aliasIndex,
    });
    const cluster = await loadClusterCard(clusterId);

    // Scoped to this test's own category/cluster, not a global count — this
    // test suite's own DB is shared across concurrently-running test FILES
    // (see vitest.config.ts: no fileParallelism: false), so a global
    // prisma.X.count() races against unrelated tests writing rows at the
    // same time and is not a reliable "nothing was mutated" signal.
    const before = {
      articles: await prisma.article.count({ where: { categoryId } }),
      observations: await prisma.provenanceObservation.count({
        where: { article: { categoryId } },
      }),
      clusters: await prisma.storyCluster.count({ where: { categoryId } }),
    };

    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = ((...args: unknown[]) => {
      fetchCalled = true;
      throw new Error(`unexpected fetch: ${JSON.stringify(args)}`);
    }) as typeof global.fetch;
    try {
      await loadStoryIntelligence(cluster, null);
    } finally {
      global.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);

    const after = {
      articles: await prisma.article.count({ where: { categoryId } }),
      observations: await prisma.provenanceObservation.count({
        where: { article: { categoryId } },
      }),
      clusters: await prisma.storyCluster.count({ where: { categoryId } }),
    };
    expect(after).toEqual(before);
  });
});

describe("resolveStoryIntelligenceViewerId fails safely to anonymous", () => {
  it("returns null instead of throwing when called outside a Next.js request scope", async () => {
    const { resolveStoryIntelligenceViewerId } = await import("@/lib/storyIntelligence");
    // Calling getCurrentUser() (which reads next/headers' cookies()) outside
    // a real request scope throws — this proves resolveStoryIntelligenceViewerId
    // catches that and fails safely to anonymous, exactly like
    // resolveViewerAdEligibility's own precedent, rather than propagating
    // and taking down the whole story page.
    await expect(resolveStoryIntelligenceViewerId()).resolves.toBeNull();
  });
});
