import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { persistClaimsForArticle } from "@/lib/claims/persistClaims";
import { loadCoverageComparison } from "@/lib/coverageComparison";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";
import { seedPlans } from "../prisma/seedPlans";
import type { StoryClusterCard } from "@/lib/stories";

let categoryId: string;
let sourceId: string;
let freeUserId: string;
let basicUserId: string;
let proUserId: string;
let articleCounter = 0;

beforeAll(async () => {
  await seedProvenanceEntities(prisma);
  await seedPlans(prisma);

  const category = await prisma.category.create({
    data: { slug: "test-coverage-comparison", name: "Test Coverage Comparison", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test Coverage Comparison Source",
      url: "https://coverage-comparison-test.example.com/feed.xml",
      categorySlug: "test-coverage-comparison",
    },
  });
  sourceId = source.id;

  const [freePlan, basicPlan, proPlan] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { slug: "free" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "basic" } }),
    prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } }),
  ]);
  const [freeUser, basicUser, proUser] = await Promise.all([
    prisma.user.create({ data: { email: "free-cc@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "basic-cc@example.com", passwordHash: "x" } }),
    prisma.user.create({ data: { email: "pro-cc@example.com", passwordHash: "x" } }),
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
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
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
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeCluster(): Promise<string> {
  articleCounter += 1;
  const cluster = await prisma.storyCluster.create({
    data: {
      headline: `Test coverage cluster ${articleCounter}`,
      slug: `test-coverage-${articleCounter}-${Date.now()}`,
      categoryId,
      firstSeenAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  });
  return cluster.id;
}

async function makeArticle(clusterId: string | null, title: string): Promise<string> {
  articleCounter += 1;
  const url = `https://coverage-comparison-test.example.com/a${articleCounter}`;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title,
      titleNormalized: title.toLowerCase(),
      publishedAt: new Date(),
      categoryId,
      clusterId,
    },
  });
  return article.id;
}

async function loadClusterCard(clusterId: string): Promise<StoryClusterCard> {
  return prisma.storyCluster.findUniqueOrThrow({
    where: { id: clusterId },
    include: {
      category: true,
      articles: { orderBy: { publishedAt: "asc" }, include: { source: true } },
    },
  });
}

describe("entitlement tiers", () => {
  it("Free/logged-out get a bounded preview with no sourceOverlap/occurrences", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId, "Fire coverage one");
    const a2 = await makeArticle(clusterId, "Fire coverage two");
    await persistClaimsForArticle(prisma, {
      articleId: a1,
      text: "12 people were injured in the fire.",
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    await persistClaimsForArticle(prisma, {
      articleId: a2,
      text: "12 people were injured in the fire, officials confirmed.",
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const cluster = await loadClusterCard(clusterId);

    for (const userId of [freeUserId, null]) {
      const result = await loadCoverageComparison(cluster, userId);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.hasFullAccess).toBe(false);
      expect(result.claimGroups[0]?.sourceOverlap).toBeUndefined();
      expect(result.claimGroups[0]?.occurrences).toBeUndefined();
    }
  });

  it("Basic gets sourceOverlap but not occurrences; Pro gets both", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId, "Fire coverage one");
    const a2 = await makeArticle(clusterId, "Fire coverage two");
    await persistClaimsForArticle(prisma, {
      articleId: a1,
      text: "12 people were injured in the fire.",
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    await persistClaimsForArticle(prisma, {
      articleId: a2,
      text: "12 people were injured in the fire, officials confirmed.",
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const cluster = await loadClusterCard(clusterId);

    const basicResult = await loadCoverageComparison(cluster, basicUserId);
    expect(basicResult.status).toBe("ok");
    if (basicResult.status !== "ok") throw new Error("unreachable");
    expect(basicResult.hasFullAccess).toBe(true);
    expect(basicResult.hasClaimComparison).toBe(false);
    expect(basicResult.claimGroups[0]?.occurrences).toBeUndefined();

    const proResult = await loadCoverageComparison(cluster, proUserId);
    expect(proResult.status).toBe("ok");
    if (proResult.status !== "ok") throw new Error("unreachable");
    expect(proResult.hasClaimComparison).toBe(true);
    expect(proResult.claimGroups[0]?.occurrences).toHaveLength(2);
  });
});

describe("repetition vs. corroboration end-to-end", () => {
  it("exposes both articleCount and Reuters source-overlap as separate facts, never combined", async () => {
    const clusterId = await makeCluster();
    const r1 = await makeArticle(clusterId, "Reuters coverage one");
    const r2 = await makeArticle(clusterId, "Reuters coverage two");
    const aliasIndex = await (
      await import("@/lib/provenance/persistObservations")
    ).loadAliasIndex(prisma);
    const { persistObservationsForArticle } = await import("@/lib/provenance/persistObservations");

    // Both articles cite Reuters (Phase 8 source-group signal) AND both
    // contain the same numerical assertion (Phase 10 claim signal).
    for (const articleId of [r1, r2]) {
      await persistObservationsForArticle(prisma, {
        articleId,
        text: "Reuters reported the incident. 12 people were injured in the incident.",
        extractionSource: "FEED_TEXT",
        publisherName: "Test Coverage Comparison Source",
        aliasIndex,
      });
      await persistClaimsForArticle(prisma, {
        articleId,
        text: "Reuters reported the incident. 12 people were injured in the incident.",
        extractionSource: "FEED_TEXT",
        observations: [],
      });
    }

    const cluster = await loadClusterCard(clusterId);
    const result = await loadCoverageComparison(cluster, proUserId);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");

    const numericalGroup = result.claimGroups.find((g) => g.kind === "NUMERICAL_ASSERTION");
    expect(numericalGroup?.articleCount).toBe(2); // true repetition count, untouched
    expect(numericalGroup?.sourceOverlap).toEqual([
      { entityName: "Reuters", overlapArticleCount: 2 },
    ]);
    // Never combined into one derived "independence" number.
    expect(JSON.stringify(result)).not.toMatch(/independen|corroborat|confirmedBy/i);
  });
});

describe("failure isolation", () => {
  it("returns {status: unavailable} instead of throwing when the cluster no longer exists", async () => {
    const clusterId = await makeCluster();
    const cluster = await loadClusterCard(clusterId);
    await prisma.storyCluster.delete({ where: { id: clusterId } });

    const result = await loadCoverageComparison(cluster, null);
    expect(result).toEqual({ status: "unavailable" });
  });

  it("never leaks an error message or internal detail in the returned shape", async () => {
    const clusterId = await makeCluster();
    const cluster = await loadClusterCard(clusterId);
    await prisma.storyCluster.delete({ where: { id: clusterId } });

    const result = await loadCoverageComparison(cluster, null);
    expect(Object.keys(result)).toEqual(["status"]);
  });
});

describe("no mutation / no network request", () => {
  it("leaves row counts unchanged and never calls fetch", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId, "Fire coverage");
    await persistClaimsForArticle(prisma, {
      articleId: a1,
      text: "12 people were injured in the fire.",
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const cluster = await loadClusterCard(clusterId);

    const before = {
      articles: await prisma.article.count({ where: { categoryId } }),
      claims: await prisma.claim.count({ where: { article: { categoryId } } }),
      clusters: await prisma.storyCluster.count({ where: { categoryId } }),
    };

    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = ((...args: unknown[]) => {
      fetchCalled = true;
      throw new Error(`unexpected fetch: ${JSON.stringify(args)}`);
    }) as typeof global.fetch;
    try {
      await loadCoverageComparison(cluster, proUserId);
    } finally {
      global.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);

    const after = {
      articles: await prisma.article.count({ where: { categoryId } }),
      claims: await prisma.claim.count({ where: { article: { categoryId } } }),
      clusters: await prisma.storyCluster.count({ where: { categoryId } }),
    };
    expect(after).toEqual(before);
  });
});

describe("empty cluster", () => {
  it("returns ok with zero claim groups when no claims exist", async () => {
    const clusterId = await makeCluster();
    await makeArticle(clusterId, "No comparable assertions here");
    const cluster = await loadClusterCard(clusterId);

    const result = await loadCoverageComparison(cluster, null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.claimGroups).toEqual([]);
  });
});
