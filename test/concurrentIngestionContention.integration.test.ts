import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Realistic concurrent-write-contention regression for the P1008 fix:
 * several sources ingested AT ONCE (mirroring CONCURRENT_FETCHES=4 in
 * src/lib/ingest/ingestAll.ts), each with multiple items that exercise the
 * FULL per-item write chain (article create, batched keyword linking,
 * provenance observation persistence, claim persistence, then the
 * trailing Source/FeedFetchLog status write) — against the REAL SQLite
 * test database, with REAL $transaction calls throughout (only the network
 * fetch is mocked, for determinism). This is the aggregate write-volume
 * shape that produced the production P1008, not a single isolated call.
 */

vi.mock("@/lib/ingest/fetchFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/fetchFeed")>();
  return { ...actual, fetchAndParseFeed: vi.fn() };
});

const { fetchAndParseFeed } = await import("@/lib/ingest/fetchFeed");
const { ingestSource } = await import("@/lib/ingest/ingestSource");
const fetchAndParseFeedMock = fetchAndParseFeed as unknown as Mock;

const SOURCE_COUNT = 4; // matches CONCURRENT_FETCHES in src/lib/ingest/ingestAll.ts
const ITEMS_PER_SOURCE = 5;

let categoryId: string;
const sourceIds: string[] = [];

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-concurrent-ingestion", name: "Test Concurrent Ingestion", order: 999 },
  });
  categoryId = category.id;

  for (let i = 0; i < SOURCE_COUNT; i++) {
    const source = await prisma.source.create({
      data: {
        name: `Concurrent Ingestion Source ${i}`,
        url: `https://concurrent-ingestion-test.example.com/source-${i}/feed.xml`,
        categorySlug: "test-concurrent-ingestion",
      },
    });
    sourceIds.push(source.id);
  }
});

afterAll(async () => {
  await prisma.feedFetchLog.deleteMany({ where: { sourceId: { in: sourceIds } } });
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.keyword.deleteMany({ where: { term: "World Health Organization" } });
  await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  fetchAndParseFeedMock.mockReset();
});

describe("CONCURRENT_FETCHES-shaped concurrent ingestion never crashes and never loses work", () => {
  it(`ingests ${SOURCE_COUNT} sources x ${ITEMS_PER_SOURCE} items concurrently, each with a shared keyword phrase, with every status write landing correctly`, async () => {
    fetchAndParseFeedMock.mockImplementation(async (url: string) => {
      const sourceIndex = sourceIds.findIndex((_, i) => url.includes(`source-${i}/`));
      const items = Array.from({ length: ITEMS_PER_SOURCE }, (_, itemIndex) => ({
        link: `https://concurrent-ingestion-test.example.com/source-${sourceIndex}/articles/${itemIndex}`,
        // Every item across every source shares "World Health Organization"
        // — a genuine concurrent race on the SAME Keyword.term row across
        // 4 sources' worth of simultaneous article processing — plus a
        // numeric assertion (triggers real claim-persistence writes too).
        title: `World Health Organization reports ${itemIndex + 1} cases in source ${sourceIndex}`,
        isoDate: new Date().toISOString(),
      }));
      return { items };
    });

    const sources = await prisma.source.findMany({ where: { id: { in: sourceIds } } });
    expect(sources).toHaveLength(SOURCE_COUNT);

    // Fired concurrently, not awaited one at a time — this is the exact
    // shape mapWithConcurrency produces in ingestAllDueSources.
    const results = await Promise.all(sources.map((source) => ingestSource(source)));

    expect(results).toHaveLength(SOURCE_COUNT);
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.itemsFound).toBe(ITEMS_PER_SOURCE);
      expect(result.itemsNew).toBe(ITEMS_PER_SOURCE);
    }

    // Every source's own status write landed correctly — no cross-source
    // contamination, no source silently left with a stale/missing status.
    const updatedSources = await prisma.source.findMany({ where: { id: { in: sourceIds } } });
    for (const s of updatedSources) {
      expect(s.consecutiveFailures).toBe(0);
      expect(s.lastSuccessAt).not.toBeNull();
      expect(s.lastError).toBeNull();
    }

    const logs = await prisma.feedFetchLog.findMany({ where: { sourceId: { in: sourceIds } } });
    expect(logs).toHaveLength(SOURCE_COUNT);
    expect(logs.every((l) => l.success && l.itemsNew === ITEMS_PER_SOURCE)).toBe(true);

    // The shared keyword phrase collapsed to exactly ONE Keyword row
    // despite 4 sources racing to create/link it concurrently — proving
    // linkKeywords' batching + unique-constraint race recovery holds
    // under genuine concurrency, not just the single-call mocked test.
    const sharedKeyword = await prisma.keyword.findMany({
      where: { term: "World Health Organization" },
    });
    expect(sharedKeyword).toHaveLength(1);

    const totalArticles = await prisma.article.count({ where: { categoryId } });
    expect(totalArticles).toBe(SOURCE_COUNT * ITEMS_PER_SOURCE);

    const linksToSharedKeyword = await prisma.articleKeyword.count({
      where: { keywordId: sharedKeyword[0]!.id },
    });
    expect(linksToSharedKeyword).toBe(SOURCE_COUNT * ITEMS_PER_SOURCE); // every article linked, none skipped or duplicated
  }, 30_000);
});
