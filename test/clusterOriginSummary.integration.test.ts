import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import { getClusterOriginSummary } from "@/lib/graph/getClusterOriginSummary";
import { MAX_GROUP_SIZE_FOR_TEXT_COMPARISON } from "@/lib/graph/excerptSimilarity";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";
import type { AliasIndex } from "@/lib/provenance/entityResolution";

/**
 * Phase 8B integration tests: getClusterOriginSummary against a real
 * (SQLite test) database — real StoryCluster/Article/ProvenanceObservation/
 * ProvenanceEntity rows, real Phase 7B extraction where practical, and a
 * genuine assertion that calling this function mutates nothing and makes
 * no network request.
 */

let categoryId: string;
let sourceId: string;
let aliasIndex: AliasIndex;
let reutersEntityId: string;
let dojEntityId: string;
let articleCounter = 0;

beforeAll(async () => {
  await seedProvenanceEntities(prisma);
  aliasIndex = await loadAliasIndex(prisma);

  const reuters = await prisma.provenanceEntity.findUniqueOrThrow({
    where: { canonicalName: "Reuters" },
  });
  reutersEntityId = reuters.id;
  const doj = await prisma.provenanceEntity.findUniqueOrThrow({
    where: { canonicalName: "U.S. Department of Justice" },
  });
  dojEntityId = doj.id;

  const category = await prisma.category.create({
    data: { slug: "test-cluster-origin", name: "Test Cluster Origin", order: 999 },
  });
  categoryId = category.id;

  const source = await prisma.source.create({
    data: {
      name: "Test Cluster Origin Source",
      url: "https://cluster-origin-test.example.com/feed.xml",
      categorySlug: "test-cluster-origin",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.article.deleteMany({ where: { categoryId } });
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
      headline: `Test cluster ${articleCounter}`,
      slug: `test-cluster-origin-${articleCounter}-${Date.now()}`,
      categoryId,
      firstSeenAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  });
  return cluster.id;
}

async function makeArticle(
  clusterId: string | null,
  overrides: { excerpt?: string | null; sourceIdOverride?: string } = {},
): Promise<string> {
  articleCounter += 1;
  const url = `https://cluster-origin-test.example.com/article-${articleCounter}`;
  const article = await prisma.article.create({
    data: {
      sourceId: overrides.sourceIdOverride ?? sourceId,
      url,
      urlHash: hashUrl(normalizeUrl(url)),
      title: `Cluster origin test article ${articleCounter}`,
      titleNormalized: `cluster origin test article ${articleCounter}`,
      excerpt: overrides.excerpt ?? null,
      publishedAt: new Date(),
      categoryId,
      clusterId,
    },
  });
  return article.id;
}

describe("cross-cluster isolation — reasoning never leaks across StoryCluster boundaries", () => {
  it("never includes an article (or its Reuters citation) from a different cluster, even citing the same entity", async () => {
    const clusterId = await makeCluster();
    const otherClusterId = await makeCluster();

    const inCluster = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: inCluster,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const inOtherCluster = await makeArticle(otherClusterId);
    await persistObservationsForArticle(prisma, {
      articleId: inOtherCluster,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    expect(summary.articleCount).toBe(1);
    // Only one article cites Reuters within THIS cluster — a citing
    // article in a different cluster must never count toward "shared"
    // here, and no group forms from a single in-cluster citation.
    expect(summary.sharedReportingSourceGroups).toEqual([]);
    const allArticleIds = [
      ...summary.sharedReportingSourceGroups.flatMap((g) => g.articleIds),
      ...summary.originalReportingSignals.map((s) => s.articleId),
    ];
    expect(allArticleIds).not.toContain(inOtherCluster);
  });
});

describe("A/D — shared reporting source groups via real extraction", () => {
  it("groups Reuters citations separately from AP citations within one cluster", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);
    const a3 = await makeArticle(clusterId);
    const a4 = await makeArticle(clusterId);

    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the negotiations concluded successfully this morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a3,
      text: "AP reported the mayor's office issued a statement Tuesday afternoon.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a4,
      text: "AP reported the mayor's office issued a statement Wednesday morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);

    expect(summary.articleCount).toBe(4);
    expect(summary.sharedReportingSourceGroups).toHaveLength(2);

    const reutersGroup = summary.sharedReportingSourceGroups.find(
      (g) => g.entityCanonicalName === "Reuters",
    );
    const apGroup = summary.sharedReportingSourceGroups.find(
      (g) => g.entityCanonicalName === "Associated Press",
    );
    expect(reutersGroup?.articleIds.sort()).toEqual([a1, a2].sort());
    expect(apGroup?.articleIds.sort()).toEqual([a3, a4].sort());
    expect(reutersGroup?.confidence).toBe("POSSIBLE");
    expect(apGroup?.confidence).toBe("POSSIBLE");

    // Multiple separate metrics, never one collapsed score.
    expect(summary).not.toHaveProperty("independentOriginCount");
    expect(summary).not.toHaveProperty("originScore");
    expect(summary).not.toHaveProperty("reliabilityScore");
    expect(summary).not.toHaveProperty("truthScore");
    expect(summary).not.toHaveProperty("corroborationScore");
  });
});

describe("B/C — near-duplicate excerpt signal via real Article.excerpt rows", () => {
  it("C — flags a STRONGLY_INFERRED LIKELY_SHARED_TEXT_ORIGIN signal for near-identical excerpts inside the same entity group", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId, {
      excerpt: "Reuters reported the storm caused significant damage across the coastline today.",
    });
    const a2 = await makeArticle(clusterId, {
      excerpt:
        "Reuters reported the storm caused significant damage across the coastline this morning.",
    });

    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the storm caused significant damage across the coastline today.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the storm caused significant damage across the coastline this morning.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    const group = summary.sharedReportingSourceGroups.find(
      (g) => g.entityCanonicalName === "Reuters",
    );
    expect(group?.nearDuplicateTextSignals).toHaveLength(1);
    expect(group?.nearDuplicateTextSignals[0]).toMatchObject({
      label: "LIKELY_SHARED_TEXT_ORIGIN",
      confidence: "STRONGLY_INFERRED",
    });
    // Locked language: never a stronger label than this.
    expect(JSON.stringify(group)).not.toMatch(
      /SAME_REUTERS_DISPATCH|CONFIRMED_SAME_ORIGIN|CONFIRMED/,
    );
  });

  it("B — produces no near-duplicate signal for dissimilar excerpts even when they share the same entity", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId, {
      excerpt: "Reuters reported the storm caused significant damage across the coastline.",
    });
    const a2 = await makeArticle(clusterId, {
      excerpt:
        "Reuters reported that lawmakers reached a compromise on the budget bill late Friday.",
    });

    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the storm caused significant damage across the coastline.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported that lawmakers reached a compromise on the budget bill late Friday.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    const group = summary.sharedReportingSourceGroups.find(
      (g) => g.entityCanonicalName === "Reuters",
    );
    expect(group?.nearDuplicateTextSignals).toEqual([]);
  });
});

describe("I — unresolved-article / provenance-coverage counting", () => {
  it("counts an article with zero persisted observations as unresolved, never silently omitted", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);

    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });
    // a2 gets text with no attribution language at all.
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "The weather was pleasant across the region for most of the week.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    expect(summary.articleCount).toBe(2);
    expect(summary.unresolvedArticleCount).toBe(1);
    expect(summary.provenanceCoverage).toEqual({
      articlesWithDetectedProvenance: 1,
      articlesWithoutDetectedProvenance: 1,
    });
  });
});

describe("K — real DB mergedIntoId dereferencing groups observations under the canonical entity", () => {
  it("groups an observation pointing at a duplicate (merged) entity with one pointing at the canonical entity", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);

    // Simulate a real admin-performed merge: a duplicate DOJ entity that
    // existed before being merged into the canonical seeded one. Never
    // mutates the canonical entity's own row.
    const duplicate = await prisma.provenanceEntity.create({
      data: {
        canonicalName: "Dept. of Justice (duplicate, test-only)",
        entityType: "GOVERNMENT_AGENCY",
        mergedIntoId: dojEntityId,
      },
    });

    await prisma.provenanceObservation.create({
      data: {
        articleId: a1,
        entityId: duplicate.id,
        rawEntityText: "DOJ",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
        evidenceText: "DOJ said the investigation was ongoing",
        extractionSource: "FEED_TEXT",
        startOffset: 0,
        endOffset: 3,
        extractorVersion: "attribution-regex@1",
        dedupeKey: `k-test-${a1}-dup`,
      },
    });
    await prisma.provenanceObservation.create({
      data: {
        articleId: a2,
        entityId: dojEntityId,
        rawEntityText: "Department of Justice",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "HIGH",
        evidenceText: "the Department of Justice confirmed the charges",
        extractionSource: "FEED_TEXT",
        startOffset: 0,
        endOffset: 22,
        extractorVersion: "attribution-regex@1",
        dedupeKey: `k-test-${a2}-canonical`,
      },
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    const dojGroup = summary.sharedReportingSourceGroups.find((g) => g.entityId === dojEntityId);
    expect(dojGroup).toBeDefined();
    expect(dojGroup?.articleIds.sort()).toEqual([a1, a2].sort());
    expect(dojGroup?.observations.every((o) => o.entityId === dojEntityId)).toBe(true);

    // Cleanup: never leave the test-only duplicate entity behind.
    await prisma.provenanceEntity.delete({ where: { id: duplicate.id } });
  });
});

describe("O — 1,000-article cluster stays a single group and completes in roughly linear time", () => {
  it("produces exactly ONE Reuters group for 1,000 citing articles without pairwise-comparing all of them", async () => {
    const clusterId = await makeCluster();

    const articleIds: string[] = [];
    for (let i = 0; i < 1000; i++) {
      articleIds.push(
        await makeArticle(clusterId, { excerpt: `Reuters update ${i} about the story.` }),
      );
    }

    await prisma.provenanceObservation.createMany({
      data: articleIds.map((articleId, i) => ({
        articleId,
        entityId: reutersEntityId,
        rawEntityText: "Reuters",
        relationshipType: "CITES_WIRE_SERVICE",
        evidenceType: "REPORTING_CITATION",
        confidence: "HIGH" as const,
        evidenceText: "Reuters reported the update",
        extractionSource: "FEED_TEXT",
        startOffset: 0,
        endOffset: 7,
        extractorVersion: "attribution-regex@1",
        dedupeKey: `o-test-${articleId}-${i}`,
      })),
    });

    const start = performance.now();
    const summary = await getClusterOriginSummary(prisma, clusterId);
    const elapsedMs = performance.now() - start;

    expect(summary.articleCount).toBe(1000);
    expect(summary.sharedReportingSourceGroups).toHaveLength(1);
    expect(summary.sharedReportingSourceGroups[0]!.articleIds).toHaveLength(1000);
    // Group exceeds the near-duplicate comparison cap, so no O(n^2)
    // pairwise work is performed for it (see excerptSimilarity.ts).
    expect(summary.sharedReportingSourceGroups[0]!.nearDuplicateTextSignals).toEqual([]);
    expect(1000).toBeGreaterThan(MAX_GROUP_SIZE_FOR_TEXT_COMPARISON);
    // Generous bound — this is a correctness/non-explosion guard, not a
    // tight performance benchmark; CI hardware varies.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 30_000);
});

describe("getClusterOriginSummary makes no mutation and no network request", () => {
  it("leaves row counts unchanged and never calls fetch", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const countsBefore = {
      articles: await prisma.article.count(),
      observations: await prisma.provenanceObservation.count(),
      entities: await prisma.provenanceEntity.count(),
      clusters: await prisma.storyCluster.count(),
    };

    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = ((...args: unknown[]) => {
      fetchCalled = true;
      throw new Error(
        `unexpected network call in getClusterOriginSummary: ${JSON.stringify(args)}`,
      );
    }) as typeof global.fetch;
    try {
      await getClusterOriginSummary(prisma, clusterId);
    } finally {
      global.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);

    const countsAfter = {
      articles: await prisma.article.count(),
      observations: await prisma.provenanceObservation.count(),
      entities: await prisma.provenanceEntity.count(),
      clusters: await prisma.storyCluster.count(),
    };
    expect(countsAfter).toEqual(countsBefore);
  });

  it("throws a clear error for a nonexistent cluster id rather than silently returning an empty summary", async () => {
    await expect(getClusterOriginSummary(prisma, "does-not-exist")).rejects.toThrow();
  });
});

describe("adversarial review — empty/minimal cluster states", () => {
  it("a cluster with zero articles returns an all-zero summary, not an error", async () => {
    const clusterId = await makeCluster();
    const summary = await getClusterOriginSummary(prisma, clusterId);
    expect(summary.articleCount).toBe(0);
    expect(summary.publisherCount).toBe(0);
    expect(summary.sharedReportingSourceGroups).toEqual([]);
    expect(summary.primaryEvidenceGroups).toEqual([]);
    expect(summary.originalReportingSignals).toEqual([]);
    expect(summary.unresolvedArticleCount).toBe(0);
    expect(summary.provenanceCoverage).toEqual({
      articlesWithDetectedProvenance: 0,
      articlesWithoutDetectedProvenance: 0,
    });
  });

  it("a cluster with exactly one article (with provenance) never fabricates a shared-source group", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    await persistObservationsForArticle(prisma, {
      articleId: a1,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    expect(summary.articleCount).toBe(1);
    expect(summary.sharedReportingSourceGroups).toEqual([]);
    expect(summary.unresolvedArticleCount).toBe(0);
  });
});

describe("adversarial review — extractorVersion is never silently mixed", () => {
  it("excludes a stale-extractorVersion auto-generated observation from grouping, while including a current-version one from another article", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);

    // a1 has a STALE-version auto-generated Reuters observation (as if the
    // extractor was bumped and this article hasn't been reprocessed yet).
    await prisma.provenanceObservation.create({
      data: {
        articleId: a1,
        entityId: reutersEntityId,
        rawEntityText: "Reuters",
        relationshipType: "CITES_WIRE_SERVICE",
        evidenceType: "REPORTING_CITATION",
        confidence: "HIGH",
        evidenceText: "Reuters reported (stale extraction)",
        extractionSource: "FEED_TEXT",
        startOffset: 0,
        endOffset: 7,
        extractorVersion: "attribution-regex@0-old",
        dedupeKey: `stale-version-${a1}`,
      },
    });
    // a2 has a CURRENT-version Reuters observation via real extraction.
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    // Only ONE article has a current-version observation — not "shared",
    // and a1's stale row must never be silently blended in to make it look
    // like two articles corroborate each other.
    expect(summary.sharedReportingSourceGroups).toEqual([]);
    expect(summary.provenanceCoverage.articlesWithDetectedProvenance).toBe(1);
    expect(summary.provenanceCoverage.articlesWithoutDetectedProvenance).toBe(1);
  });

  it("an ADMIN_OVERRIDE row is always included regardless of its own extractorVersion tag", async () => {
    const clusterId = await makeCluster();
    const a1 = await makeArticle(clusterId);
    const a2 = await makeArticle(clusterId);

    // a1's ADMIN_OVERRIDE row carries an OLD extractorVersion tag (as it
    // would if it was manually corrected before a later version bump) —
    // it must still count as detected provenance and still be groupable.
    await prisma.provenanceObservation.create({
      data: {
        articleId: a1,
        entityId: reutersEntityId,
        rawEntityText: "Reuters",
        relationshipType: "CITES_WIRE_SERVICE",
        evidenceType: "REPORTING_CITATION",
        confidence: "HIGH",
        evidenceText: "Reuters reported (admin-corrected, old version tag)",
        extractionSource: "FEED_TEXT",
        startOffset: 0,
        endOffset: 7,
        extractorVersion: "attribution-regex@0-old",
        reviewState: "ADMIN_OVERRIDE",
        dedupeKey: `admin-override-old-version-${a1}`,
      },
    });
    await persistObservationsForArticle(prisma, {
      articleId: a2,
      text: "Reuters reported the negotiations concluded successfully overnight.",
      extractionSource: "FEED_TEXT",
      publisherName: "Test Cluster Origin Source",
      aliasIndex,
    });

    const summary = await getClusterOriginSummary(prisma, clusterId);
    const reutersGroup = summary.sharedReportingSourceGroups.find(
      (g) => g.entityCanonicalName === "Reuters",
    );
    expect(reutersGroup).toBeDefined();
    expect(reutersGroup?.articleIds.sort()).toEqual([a1, a2].sort());
    expect(summary.provenanceCoverage.articlesWithDetectedProvenance).toBe(2);
  });
});
