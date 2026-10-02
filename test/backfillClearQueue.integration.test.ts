import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  CLAIM_EXTRACTOR_VERSION,
  clearStaleClaims,
  persistClaimsForArticle,
} from "@/lib/claims/persistClaims";
import {
  EXTRACTOR_VERSION,
  clearStaleObservations,
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";

/**
 * Regression coverage for moving worker/backfill-claims.ts's
 * clearStaleClaims and worker/backfill-provenance.ts's
 * clearStaleObservations deleteMany calls inside src/lib/writeQueue.ts's
 * queue. Both backfill scripts run their own CONCURRENCY=4
 * mapWithConcurrency over articles — the exact in-process write-lock
 * contention shape live ingestion has — so these delete writes must be
 * serialized against each other and against every other queue-acquiring
 * leaf, with no nested acquisition: clearStaleClaims/clearStaleObservations
 * are SIBLINGS of persistClaimsForArticle/persistObservationsForArticle
 * (each backfill script's processArticle() calls one, then separately
 * calls the other — never one from inside the other).
 */

let categoryId: string;
let sourceId: string;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-backfill-clear-queue", name: "Test Backfill Clear Queue", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test Backfill Clear Queue Source",
      url: "https://backfill-clear-queue-test.example.com/feed.xml",
      categorySlug: "test-backfill-clear-queue",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeArticle(): Promise<string> {
  articleCounter += 1;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url: `https://backfill-clear-queue-test.example.com/a${articleCounter}`,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title: `Backfill clear queue article ${articleCounter}`,
      titleNormalized: `backfill clear queue article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

/** Wraps a bound Prisma method so every call tracks concurrent-in-flight count, with an artificial delay to widen the window any real overlap would be caught in. */
function trackConcurrency<T extends (...args: never[]) => Promise<unknown>>(fn: T) {
  let active = 0;
  let maxActive = 0;
  const wrapped = (async (...args: Parameters<T>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await fn(...args);
    } finally {
      active -= 1;
    }
  }) as T;
  return { wrapped, maxActive: () => maxActive };
}

/** A concurrency tracker shared across TWO different wrapped Prisma entry points, to prove neither's critical section ever overlaps with the other's. */
function makeSharedTracker() {
  let active = 0;
  let maxActive = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5)); // widen the overlap window
      try {
        return await fn();
      } finally {
        active -= 1;
      }
    },
    maxActive: () => maxActive,
  };
}

describe("clearStaleClaims / clearStaleObservations are now queue-acquiring leaves", () => {
  it("never runs two concurrent clearStaleClaims deleteMany calls at once, even fired for 4 different articles simultaneously (CONCURRENCY=4-shaped)", async () => {
    const articleIds = await Promise.all(Array.from({ length: 4 }, () => makeArticle()));
    const original = prisma.claim.deleteMany.bind(prisma.claim);
    const { wrapped, maxActive } = trackConcurrency(original);
    vi.spyOn(prisma.claim, "deleteMany").mockImplementation(
      wrapped as unknown as typeof prisma.claim.deleteMany,
    );

    await Promise.all(
      articleIds.map((id) => clearStaleClaims(prisma, id, CLAIM_EXTRACTOR_VERSION)),
    );

    expect(maxActive()).toBe(1);
  });

  it("never runs two concurrent clearStaleObservations deleteMany calls at once, even fired for 4 different articles simultaneously", async () => {
    const articleIds = await Promise.all(Array.from({ length: 4 }, () => makeArticle()));
    const original = prisma.provenanceObservation.deleteMany.bind(prisma.provenanceObservation);
    const { wrapped, maxActive } = trackConcurrency(original);
    vi.spyOn(prisma.provenanceObservation, "deleteMany").mockImplementation(
      wrapped as unknown as typeof prisma.provenanceObservation.deleteMany,
    );

    await Promise.all(
      articleIds.map((id) => clearStaleObservations(prisma, id, EXTRACTOR_VERSION)),
    );

    expect(maxActive()).toBe(1);
  });

  it("clearStaleClaims's deleteMany and persistClaimsForArticle's own interactive transaction never overlap either, proving they share ONE queue rather than two independent ones", async () => {
    const articleIds = await Promise.all(Array.from({ length: 4 }, () => makeArticle()));

    // clearStaleClaims issues a plain (non-transactional) prisma.claim.
    // deleteMany; persistClaimsForArticle runs its findMany+createMany
    // inside a callback-form prisma.$transaction — a DIFFERENT client
    // object (`tx`, not `prisma.claim` directly). Both critical sections
    // are routed through the SAME shared tracker below, so overlap
    // between EITHER leaf's write-containing section (not just within
    // one leaf) would be caught.
    const tracker = makeSharedTracker();

    const originalDeleteMany = prisma.claim.deleteMany.bind(prisma.claim);
    vi.spyOn(prisma.claim, "deleteMany").mockImplementation(((args: unknown) =>
      tracker.run(() =>
        (originalDeleteMany as (args: unknown) => Promise<unknown>)(args),
      )) as unknown as typeof prisma.claim.deleteMany);

    const originalTransaction = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, ...rest: unknown[]) =>
      tracker.run(() =>
        (originalTransaction as (...args: unknown[]) => Promise<unknown>)(arg, ...rest),
      )) as unknown as typeof prisma.$transaction);

    // Mirrors worker/backfill-claims.ts's processArticle shape exactly:
    // clear, then persist, called sequentially per article but across
    // CONCURRENCY=4 articles at once via Promise.all (mapWithConcurrency's
    // own fan-out shape).
    await Promise.all(
      articleIds.map(async (articleId) => {
        await clearStaleClaims(prisma, articleId, CLAIM_EXTRACTOR_VERSION);
        await persistClaimsForArticle(prisma, {
          articleId,
          text: "12 people were injured in the incident",
          extractionSource: "TITLE",
          observations: [],
        });
      }),
    );

    // Neither leaf's write-containing section ever overlapped with its
    // own repeats OR with the other leaf's — proving a single shared
    // queue, not two leaves racing on independent queues.
    expect(tracker.maxActive()).toBe(1);

    // Sanity: every article actually got its claim persisted — proves the
    // serialization didn't silently drop or deadlock any of the 4 calls.
    const claims = await prisma.claim.findMany({ where: { articleId: { in: articleIds } } });
    expect(claims).toHaveLength(4);
  }, 10_000);
});

describe("no deadlock: concurrent backfill-shaped clear+persist cycles always complete", () => {
  it("completes 8 concurrent clear+persist cycles (double CONCURRENCY=4) within a non-flaky time bound, proving no nested acquisition hangs the queue", async () => {
    const articleIds = await Promise.all(Array.from({ length: 8 }, () => makeArticle()));
    const aliasIndex = await loadAliasIndex(prisma);

    const startedAt = Date.now();
    await Promise.all(
      articleIds.map(async (articleId) => {
        await clearStaleObservations(prisma, articleId, EXTRACTOR_VERSION);
        await persistObservationsForArticle(prisma, {
          articleId,
          text: "Reuters reported the incident",
          extractionSource: "TITLE",
          publisherName: "Test Publisher",
          aliasIndex,
        });
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    // Generous hang/deadlock guard, not a performance assertion — if
    // clearStaleObservations ever nested a second queue acquisition
    // inside persistObservationsForArticle (or vice versa), this would
    // hang indefinitely and fail via the test's own timeout instead.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
