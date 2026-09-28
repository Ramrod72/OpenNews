import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import type { StoryClusterCard } from "@/lib/stories";

/**
 * Phase 9B final-review fix: an entitlement-lookup failure (can() throwing —
 * a DB hiccup, a malformed plan row, anything unexpected) must fail CLOSED
 * to hasFullAccess=false (the Free/logged-out experience), never grant full
 * provenance access, and — unlike a getClusterOriginSummary failure — must
 * NOT take down the whole Story Intelligence section when the underlying
 * sourcing data is otherwise available. Mocked at module scope (like
 * test/provenanceExtractionFailureIsolation.integration.test.ts) so this
 * failure mode is isolated to this file and doesn't affect the real
 * entitlement checks the other Story Intelligence integration tests rely
 * on.
 */
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return {
    ...actual,
    can: vi.fn().mockRejectedValue(new Error("simulated entitlement service failure")),
  };
});

const { loadStoryIntelligence } = await import("@/lib/storyIntelligence");

let categoryId: string;
let sourceId: string;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-si-entitlement-failure", name: "Test SI Entitlement Failure", order: 999 },
  });
  categoryId = category.id;

  const source = await prisma.source.create({
    data: {
      name: "Test SI Entitlement Failure Source",
      url: "https://si-entitlement-failure-test.example.com/feed.xml",
      categorySlug: "test-si-entitlement-failure",
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

describe("entitlement lookup failure fails closed to Free, without hiding available sourcing data", () => {
  it("resolves hasFullAccess: false (never true) when can() throws, while still returning the real counts", async () => {
    const cluster = await prisma.storyCluster.create({
      data: {
        headline: "Entitlement failure test cluster",
        slug: `si-entitlement-failure-${Date.now()}`,
        categoryId,
        firstSeenAt: new Date(),
        lastUpdatedAt: new Date(),
      },
    });
    const url = "https://si-entitlement-failure-test.example.com/a1";
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

    // A "pro" userId is irrelevant here — can() is mocked to always throw
    // regardless of input, simulating the entitlement service itself being
    // unavailable rather than any particular plan lookup failing.
    const result = await loadStoryIntelligence(clusterCard, "some-user-id");

    expect(result.status).toBe("ok"); // graph summary still loaded fine
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.hasFullAccess).toBe(false); // fails CLOSED, never grants full access
    expect(result.articleCount).toBe(1); // real data still surfaced, not hidden
  });
});
