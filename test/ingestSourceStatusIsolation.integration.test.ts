import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prisma } from "@/lib/db";
import { ingestSource } from "@/lib/ingest/ingestSource";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import type { Source } from "@prisma/client";

/**
 * Regression coverage for the P1008 production fix: a transient failure
 * writing the small trailing Source.update+FeedFetchLog.create status
 * transaction must never discard the real itemsFound/itemsNew counts,
 * never force a wasted full re-fetch of already-successfully-persisted
 * articles, and — critically — must never propagate uncaught out of
 * ingestSource (which previously could fail the ENTIRE worker tick for
 * every other concurrently-fetching source, not just this one).
 *
 * fetchAndParseFeed is mocked (network-free, deterministic); prisma.
 * $transaction is spied on so only the ARRAY-form status-write calls
 * (recordSuccessStatus/recordFailureStatus) are ever intercepted — every
 * other $transaction call in this execution path (persistObservations.ts/
 * persistClaims.ts's own callback-form interactive transactions) is always
 * passed through untouched.
 */

vi.mock("@/lib/ingest/fetchFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/fetchFeed")>();
  return { ...actual, fetchAndParseFeed: vi.fn() };
});

const { fetchAndParseFeed } = await import("@/lib/ingest/fetchFeed");
const fetchAndParseFeedMock = fetchAndParseFeed as unknown as Mock;

let categoryId: string;
let sourceId: string;
let source: Source;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: {
      slug: "test-ingest-status-isolation",
      name: "Test Ingest Status Isolation",
      order: 999,
    },
  });
  categoryId = category.id;

  source = await prisma.source.create({
    data: {
      name: "Test Ingest Status Isolation Source",
      url: "https://ingest-status-isolation-test.example.com/feed.xml",
      categorySlug: "test-ingest-status-isolation",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.feedFetchLog.deleteMany({ where: { sourceId } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  fetchAndParseFeedMock.mockReset();
  await prisma.feedFetchLog.deleteMany({ where: { sourceId } });
  await prisma.article.deleteMany({ where: { categoryId } });
  // Reset the Source row's own status fields between tests, since
  // ingestSource mutates them in place on the SAME source row throughout
  // this file.
  await prisma.source.update({
    where: { id: sourceId },
    data: {
      lastFetchedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
    },
  });
});

beforeEach(() => {
  // Re-fetch the latest Source row each test, since ingestSource takes a
  // Source object (not just an id) and afterEach resets DB fields that a
  // stale in-memory `source` reference wouldn't reflect.
});

function makeItem(suffix: string) {
  articleCounter += 1;
  return {
    link: `https://ingest-status-isolation-test.example.com/articles/${suffix}-${articleCounter}`,
    title: `Status isolation test article ${articleCounter}`,
    isoDate: new Date().toISOString(),
  };
}

/** Wraps the real prisma client so only ARRAY-form $transaction calls (the status writes) can be made to fail; every other call (including callback-form interactive transactions) always passes through to the real implementation untouched. */
function spyOnStatusWriteTransaction(failTimes: number) {
  const original = prisma.$transaction.bind(prisma);
  let arrayCallCount = 0;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
    arg: unknown,
    ...rest: unknown[]
  ) => {
    if (Array.isArray(arg)) {
      arrayCallCount += 1;
      if (arrayCallCount <= failTimes) {
        return Promise.reject(new Error("simulated status-write contention"));
      }
    }
    return (original as (...args: unknown[]) => unknown)(arg, ...rest);
  }) as unknown as typeof prisma.$transaction);
  return { spy, callCount: () => arrayCallCount };
}

describe("successful persistence survives a transient status-write failure", () => {
  it("retries the status write on its own and still reports accurate itemsFound/itemsNew, without re-fetching the feed", async () => {
    const item = makeItem("retry-success");
    fetchAndParseFeedMock.mockResolvedValueOnce({ items: [item] });
    const { callCount } = spyOnStatusWriteTransaction(1); // fails once, succeeds on retry

    const freshSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    const result = await ingestSource(freshSource);

    expect(result.success).toBe(true);
    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(1);
    expect(fetchAndParseFeedMock).toHaveBeenCalledTimes(1); // no wasted re-fetch
    expect(callCount()).toBeGreaterThanOrEqual(2); // first attempt failed, retry succeeded

    const updatedSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    expect(updatedSource.lastSuccessAt).not.toBeNull();
    expect(updatedSource.consecutiveFailures).toBe(0);

    const logs = await prisma.feedFetchLog.findMany({ where: { sourceId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(true);
    expect(logs[0]!.itemsNew).toBe(1);
  });
});

describe("successful persistence survives the status write being permanently unavailable", () => {
  it("still reports the real success/itemsNew/itemsFound, never re-fetches, and never throws, even though no status row ever gets written", async () => {
    const item = makeItem("permanent-fail");
    fetchAndParseFeedMock.mockResolvedValueOnce({ items: [item] });
    spyOnStatusWriteTransaction(Number.POSITIVE_INFINITY); // every status write attempt fails

    const freshSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

    await expect(ingestSource(freshSource)).resolves.toEqual(
      expect.objectContaining({ success: true, itemsFound: 1, itemsNew: 1 }),
    );
    expect(fetchAndParseFeedMock).toHaveBeenCalledTimes(1); // the article was never re-fetched/reprocessed

    // The article itself WAS durably persisted, despite the status write
    // never landing — this is the core "don't discard real work" guarantee.
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(item.link)) },
    });
    expect(article).not.toBeNull();

    // The status row genuinely never got written (every attempt failed) —
    // this is the accepted, logged trade-off, not silently papered over.
    const logs = await prisma.feedFetchLog.findMany({ where: { sourceId } });
    expect(logs).toHaveLength(0);
  });
});

describe("genuine fetch/parse failures are unaffected by the status-write isolation change", () => {
  it("retries the full fetch+persist attempt on a real failure, and reports failure accurately", async () => {
    fetchAndParseFeedMock.mockRejectedValue(new Error("simulated feed fetch failure"));

    const freshSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    const result = await ingestSource(freshSource);

    expect(result.success).toBe(false);
    expect(result.itemsFound).toBe(0);
    expect(result.itemsNew).toBe(0);
    expect(result.error).toContain("simulated feed fetch failure");
    // RETRY_DELAYS_MS has 2 entries -> 3 total attempts, each a real re-fetch.
    expect(fetchAndParseFeedMock).toHaveBeenCalledTimes(3);

    const updatedSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    expect(updatedSource.consecutiveFailures).toBe(1);
    expect(updatedSource.lastError).toContain("simulated feed fetch failure");

    const logs = await prisma.feedFetchLog.findMany({ where: { sourceId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(false);
  }, 10_000);

  it("never throws even when BOTH the fetch AND the failure-status write fail", async () => {
    fetchAndParseFeedMock.mockRejectedValue(new Error("simulated feed fetch failure"));
    spyOnStatusWriteTransaction(Number.POSITIVE_INFINITY);

    const freshSource = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

    // This is the exact scenario that previously propagated uncaught out
    // of ingestSource and, via mapWithConcurrency's un-caught Promise.all,
    // failed the entire worker tick for every other concurrently-fetching
    // source — resolving (not rejecting) here is the regression assertion.
    await expect(ingestSource(freshSource)).resolves.toEqual(
      expect.objectContaining({ success: false, itemsFound: 0, itemsNew: 0 }),
    );

    const logs = await prisma.feedFetchLog.findMany({ where: { sourceId } });
    expect(logs).toHaveLength(0); // the failure-status write genuinely never landed either
  }, 10_000);
});
