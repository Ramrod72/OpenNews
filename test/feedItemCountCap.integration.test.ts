import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { persistItems, MAX_ITEMS_PER_FETCH } from "@/lib/ingest/ingestSource";
import type { FeedItem } from "@/lib/ingest/fetchFeed";

/**
 * Phase 14B — M3: a single feed fetch must never process more than
 * MAX_ITEMS_PER_FETCH items, regardless of how many the parsed feed
 * actually contains — bounding the DB writes + provenance/claim
 * extraction work a single malicious/compromised feed origin can force
 * per ingestion run.
 */
let categoryId: string;
let source: Awaited<ReturnType<typeof prisma.source.create>>;

function makeItems(count: number, prefix: string): FeedItem[] {
  return Array.from({ length: count }, (_, i) => ({
    link: `https://feed-cap-test.example.com/${prefix}/${i}`,
    title: `Item ${prefix} ${i}`,
    isoDate: new Date().toISOString(),
  })) as FeedItem[];
}

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-feed-item-cap", name: "Test Feed Item Cap", order: 999 },
  });
  categoryId = category.id;

  source = await prisma.source.create({
    data: {
      name: "Test Feed Item Cap Source",
      url: "https://feed-cap-test.example.com/feed.xml",
      categorySlug: "test-feed-item-cap",
    },
  });
});

afterAll(async () => {
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: source.id } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  await prisma.article.deleteMany({ where: { categoryId } });
  vi.restoreAllMocks();
});

describe("below cap", () => {
  it("a feed with fewer items than the cap processes every item", async () => {
    const items = makeItems(10, "below");
    const result = await persistItems(source, items);
    expect(result.itemsFound).toBe(10);
    expect(result.itemsNew).toBe(10);
    const count = await prisma.article.count({ where: { categoryId } });
    expect(count).toBe(10);
  });
});

describe("exactly at cap", () => {
  it(`a feed with exactly ${MAX_ITEMS_PER_FETCH} items processes all of them`, async () => {
    const items = makeItems(MAX_ITEMS_PER_FETCH, "exact");
    const result = await persistItems(source, items);
    expect(result.itemsFound).toBe(MAX_ITEMS_PER_FETCH);
    expect(result.itemsNew).toBe(MAX_ITEMS_PER_FETCH);
    const count = await prisma.article.count({ where: { categoryId } });
    expect(count).toBe(MAX_ITEMS_PER_FETCH);
  }, 30_000);
});

describe("above cap", () => {
  it(`a feed with ${MAX_ITEMS_PER_FETCH + 100} items only processes the first ${MAX_ITEMS_PER_FETCH}`, async () => {
    const items = makeItems(MAX_ITEMS_PER_FETCH + 100, "above");
    const result = await persistItems(source, items);
    expect(result.itemsFound).toBe(MAX_ITEMS_PER_FETCH);
    expect(result.itemsNew).toBe(MAX_ITEMS_PER_FETCH);
    const count = await prisma.article.count({ where: { categoryId } });
    expect(count).toBe(MAX_ITEMS_PER_FETCH);

    // The (MAX_ITEMS_PER_FETCH)th-and-later items must never have reached
    // expensive per-item processing (DB write, keyword linking, provenance/
    // claim extraction) at all -- not merely "processed but later deleted".
    const overflowItem = items[items.length - 1]!;
    const stored = await prisma.article.findFirst({ where: { url: overflowItem.link } });
    expect(stored).toBeNull();
  }, 30_000);

  it("logs a truncation warning naming the true item count, without ever logging item content", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = makeItems(MAX_ITEMS_PER_FETCH + 5, "logged");
    await persistItems(source, items);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0]!;
    expect(message).toContain(String(MAX_ITEMS_PER_FETCH + 5));
    expect(message).toContain(String(MAX_ITEMS_PER_FETCH));
    // The truncation log is a fixed, hand-written template with counts
    // only -- never any of the actual (attacker-controlled) item titles.
    expect(message).not.toContain("Item logged");
  }, 30_000);
});

describe("huge synthetic feed", () => {
  it("a feed with 50,000 items still only processes the cap, and completes quickly", async () => {
    const items = makeItems(50_000, "huge");
    const startedAt = Date.now();
    const result = await persistItems(source, items);
    const elapsedMs = Date.now() - startedAt;

    expect(result.itemsFound).toBe(MAX_ITEMS_PER_FETCH);
    expect(result.itemsNew).toBe(MAX_ITEMS_PER_FETCH);
    const count = await prisma.article.count({ where: { categoryId } });
    expect(count).toBe(MAX_ITEMS_PER_FETCH);

    // Not a strict perf assertion (CI machines vary), just a sanity bound
    // proving the 50,000-entry array itself was never iterated over for
    // per-item DB/extraction work -- if it had been, this would take on
    // the order of minutes, not seconds, given per-item DB round-trips.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);

  it("truncation does not crash ingestion — the function resolves normally, not rejects", async () => {
    const items = makeItems(10_000, "no-crash");
    await expect(persistItems(source, items)).resolves.toEqual(
      expect.objectContaining({ itemsFound: MAX_ITEMS_PER_FETCH, itemsNew: MAX_ITEMS_PER_FETCH }),
    );
  }, 30_000);
});
