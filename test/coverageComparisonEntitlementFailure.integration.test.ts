import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import type { StoryClusterCard } from "@/lib/stories";

/**
 * Phase 10B: an entitlement-lookup failure (can() throwing) must fail
 * CLOSED to hasFullAccess=false / hasClaimComparison=false, never grant
 * access, and must NOT hide already-available data — the exact same
 * pattern test/storyIntelligenceEntitlementFailure.integration.test.ts
 * already establishes for Phase 9B. Mocked at module scope so this
 * failure mode is isolated to this file.
 */
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return {
    ...actual,
    can: vi.fn().mockRejectedValue(new Error("simulated entitlement service failure")),
  };
});

const { loadCoverageComparison } = await import("@/lib/coverageComparison");

let categoryId: string;
let sourceId: string;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-cc-entitlement-failure", name: "Test CC Entitlement Failure", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test CC Entitlement Failure Source",
      url: "https://cc-entitlement-failure-test.example.com/feed.xml",
      categorySlug: "test-cc-entitlement-failure",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

describe("entitlement lookup failure fails closed without hiding available data", () => {
  it("resolves hasFullAccess=false and hasClaimComparison=false when can() throws, while still returning real counts", async () => {
    const cluster = await prisma.storyCluster.create({
      data: {
        headline: "Entitlement failure test cluster",
        slug: `cc-entitlement-failure-${Date.now()}`,
        categoryId,
        firstSeenAt: new Date(),
        lastUpdatedAt: new Date(),
      },
    });
    const url = "https://cc-entitlement-failure-test.example.com/a1";
    await prisma.article.create({
      data: {
        sourceId,
        url,
        urlHash: hashUrl(normalizeUrl(url)),
        title: "Article while entitlements are broken",
        titleNormalized: "article while entitlements are broken",
        publishedAt: new Date(),
        categoryId,
        clusterId: cluster.id,
      },
    });

    const clusterCard: StoryClusterCard = await prisma.storyCluster.findUniqueOrThrow({
      where: { id: cluster.id },
      include: {
        category: true,
        articles: { orderBy: { publishedAt: "asc" }, include: { source: true } },
      },
    });

    const result = await loadCoverageComparison(clusterCard, "some-user-id");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.hasFullAccess).toBe(false);
    expect(result.hasClaimComparison).toBe(false);
    expect(result.articleCount).toBe(1);
  });
});
