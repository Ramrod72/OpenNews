import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prisma } from "@/lib/db";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";

/**
 * Production-shaped SQLite write-contention stress test for
 * src/lib/writeQueue.ts. This is the test that would have caught the
 * production P1008 (Article create) and P2028 (persistObservationsForArticle
 * interactive transaction expiry) regressions this queue fixes: SOURCE_COUNT
 * sources, each with ITEMS_PER_SOURCE brand-new articles, ingested
 * CONCURRENTLY (the exact `Promise.all` shape mapWithConcurrency produces in
 * ingestAllDueSources — see src/lib/ingest/ingestAll.ts's
 * CONCURRENT_FETCHES), each article exercising the FULL write chain:
 * article create -> batched keyword linking -> provenance observation
 * persistence -> claim persistence, against the REAL SQLite test database
 * with REAL $transaction calls throughout. Only the network fetch is
 * mocked, for determinism.
 *
 * Every title follows the shape "Reuters reported <N> people were killed in
 * source <s> wave <i>", which deterministically exercises three separate
 * write-containing paths per article at once:
 *  - a NAMED_ENTITY_ATTRIBUTION observation ("Reuters reported" resolves
 *    against the seeded Reuters alias) -> persistObservationsForArticle
 *  - a NUMERICAL_ASSERTION claim ("<N> people were killed" -> DEATHS) ->
 *    persistClaimsForArticle
 *  - the literal word "Reuters" as a shared keyword phrase across EVERY
 *    article in EVERY source -> linkKeywords, the same genuine
 *    cross-source Keyword.term race test/concurrentIngestionContention.
 *    integration.test.ts already covers at a smaller (4x5) scale, exercised
 *    here at production-representative volume instead.
 */

vi.mock("@/lib/ingest/fetchFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/fetchFeed")>();
  return { ...actual, fetchAndParseFeed: vi.fn() };
});

const { fetchAndParseFeed } = await import("@/lib/ingest/fetchFeed");
const { ingestSource } = await import("@/lib/ingest/ingestSource");
const fetchAndParseFeedMock = fetchAndParseFeed as unknown as Mock;

// Matches CONCURRENT_FETCHES in src/lib/ingest/ingestAll.ts exactly — the
// real number of sources fetched/persisted at once in production.
const SOURCE_COUNT = 4;
// Within the user-specified 20-30 "new articles per source" production
// range. 25 was chosen (not 30) after confirming via a local timing probe
// that the smaller 4x5 shape in concurrentIngestionContention.integration.
// test.ts completes in ~0.2s end-to-end for the full write chain; at 5x the
// per-source volume (4x25=100 articles, each performing article+keyword+
// provenance+claim writes) this test completes in well under 10s (see the
// runtime guard below), leaving ample headroom under typical CI timeouts
// without the test needing to run any longer than it takes to prove the
// fix — going to 30 would only add ~20% more volume for no additional
// coverage of a different code path.
const ITEMS_PER_SOURCE = 25;
const TOTAL_ARTICLES = SOURCE_COUNT * ITEMS_PER_SOURCE;
// Generous (not tight) — this guards against a genuine hang/deadlock in
// the write queue, not against ordinary CI machine variance. The real
// observed local runtime is roughly 1-2s for this volume.
const RUNTIME_GUARD_MS = 30_000;

let categoryId: string;
const sourceIds: string[] = [];

beforeAll(async () => {
  // This test DB is created fresh from migrations only (never seeded) — the
  // small provenance alias table the "Reuters reported" attribution depends
  // on must be seeded here, exactly as provenanceIngestion.integration.test.ts
  // already does for the same reason.
  await seedProvenanceEntities(prisma);

  const category = await prisma.category.create({
    data: { slug: "test-write-queue-stress", name: "Test Write Queue Stress", order: 999 },
  });
  categoryId = category.id;

  for (let i = 0; i < SOURCE_COUNT; i++) {
    const source = await prisma.source.create({
      data: {
        name: `Write Queue Stress Source ${i}`,
        url: `https://write-queue-stress-test.example.com/source-${i}/feed.xml`,
        categorySlug: "test-write-queue-stress",
      },
    });
    sourceIds.push(source.id);
  }
});

afterAll(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.feedFetchLog.deleteMany({ where: { sourceId: { in: sourceIds } } });
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.keyword.deleteMany({ where: { term: "Reuters" } });
  await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchAndParseFeedMock.mockReset();
});

describe("production-shaped SQLite write-contention stress: 4 concurrent sources x 25 full-write articles", () => {
  it(
    "ingests every article with zero P1008/P2028, zero drops, and zero duplicates under real CONCURRENT_FETCHES-shaped concurrency",
    async () => {
      fetchAndParseFeedMock.mockImplementation(async (url: string) => {
        const sourceIndex = sourceIds.findIndex((_, i) => url.includes(`source-${i}/`));
        const items = Array.from({ length: ITEMS_PER_SOURCE }, (_, itemIndex) => ({
          link: `https://write-queue-stress-test.example.com/source-${sourceIndex}/articles/${itemIndex}`,
          title: `Reuters reported ${itemIndex + 1} people were killed in source ${sourceIndex} wave ${itemIndex}`,
          isoDate: new Date().toISOString(),
        }));
        return { items };
      });

      // Fails loudly on ANY unexpected error surfaced anywhere in the write
      // path — including, critically, a P1008 or P2028 that got caught and
      // merely logged rather than thrown (every one of persistItems',
      // extractAndPersistProvenance's, extractAndPersistClaims's, and
      // linkKeywords' own isolation try/catch blocks route failures through
      // console.error) — so this test cannot pass by silently swallowing
      // the exact production failures it exists to catch.
      const consoleErrorSpy = vi.spyOn(console, "error");

      const sources = await prisma.source.findMany({ where: { id: { in: sourceIds } } });
      expect(sources).toHaveLength(SOURCE_COUNT);

      const startedAt = Date.now();
      // Fired concurrently, not awaited one at a time — the exact shape
      // mapWithConcurrency produces in ingestAllDueSources.
      const results = await Promise.all(sources.map((source) => ingestSource(source)));
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(RUNTIME_GUARD_MS);

      expect(results).toHaveLength(SOURCE_COUNT);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.itemsFound).toBe(ITEMS_PER_SOURCE);
        expect(result.itemsNew).toBe(ITEMS_PER_SOURCE);
      }

      // The core regression assertion: no P1008, no P2028, and no other
      // unexpected failure was logged anywhere along the write path.
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      // Every source's own status write landed — no cross-source
      // contamination from the shared write queue.
      const updatedSources = await prisma.source.findMany({ where: { id: { in: sourceIds } } });
      for (const s of updatedSources) {
        expect(s.consecutiveFailures).toBe(0);
        expect(s.lastSuccessAt).not.toBeNull();
        expect(s.lastError).toBeNull();
      }
      const logs = await prisma.feedFetchLog.findMany({ where: { sourceId: { in: sourceIds } } });
      expect(logs).toHaveLength(SOURCE_COUNT);
      expect(logs.every((l) => l.success && l.itemsNew === ITEMS_PER_SOURCE)).toBe(true);

      // Every single article landed — no silent drops, no duplicates
      // (urlHash is unique per source+item, so a count match here already
      // proves both).
      const totalArticles = await prisma.article.count({ where: { categoryId } });
      expect(totalArticles).toBe(TOTAL_ARTICLES);

      // The shared "Reuters" keyword (present in every one of the 100
      // articles' titles, across all 4 concurrently-ingesting sources)
      // collapsed to exactly ONE Keyword row, and every article is linked
      // to it exactly once — proving linkKeywords' createMany-with-
      // unique-constraint-race-recovery holds at this volume, serialized
      // by the write queue rather than by accident.
      const reutersKeyword = await prisma.keyword.findMany({ where: { term: "Reuters" } });
      expect(reutersKeyword).toHaveLength(1);
      const reutersLinks = await prisma.articleKeyword.count({
        where: { keywordId: reutersKeyword[0]!.id },
      });
      expect(reutersLinks).toBe(TOTAL_ARTICLES);

      // Every article got exactly one provenance observation (the "Reuters
      // reported" attribution) — proving persistObservationsForArticle's
      // interactive transaction completed for every single call under
      // this load, none silently dropped, none duplicated.
      const observations = await prisma.provenanceObservation.findMany({
        where: { article: { categoryId } },
        select: { articleId: true, dedupeKey: true },
      });
      expect(observations).toHaveLength(TOTAL_ARTICLES);
      expect(new Set(observations.map((o) => o.articleId)).size).toBe(TOTAL_ARTICLES);
      expect(new Set(observations.map((o) => o.dedupeKey)).size).toBe(TOTAL_ARTICLES); // no duplicate dedupeKeys

      // Every article got exactly one NUMERICAL_ASSERTION claim (the
      // "<N> people were killed" -> DEATHS assertion) — proving
      // persistClaimsForArticle's interactive transaction also completed
      // for every call under the same load.
      const claims = await prisma.claim.findMany({
        where: { article: { categoryId }, kind: "NUMERICAL_ASSERTION" },
        select: { articleId: true, dedupeKey: true, numericUnit: true },
      });
      expect(claims).toHaveLength(TOTAL_ARTICLES);
      expect(new Set(claims.map((c) => c.articleId)).size).toBe(TOTAL_ARTICLES);
      expect(new Set(claims.map((c) => c.dedupeKey)).size).toBe(TOTAL_ARTICLES);
      expect(claims.every((c) => c.numericUnit === "DEATHS")).toBe(true);
    },
    RUNTIME_GUARD_MS,
  );
});
