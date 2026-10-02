import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { persistItems } from "@/lib/ingest/ingestSource";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import type { Source } from "@prisma/client";
import type { FeedItem } from "@/lib/ingest/fetchFeed";

/**
 * Regression coverage for createArticleWithRetry (src/lib/ingest/ingestSource.ts),
 * added alongside src/lib/writeQueue.ts's worker-write serialization fix.
 * Exercises the retry policy against the REAL SQLite test database (only
 * `prisma.article.create` itself is spied on, never mocked away entirely),
 * so unique-constraint behavior and the lost-acknowledgment recovery path
 * are genuine, not simulated.
 */

let categoryId: string;
let sourceId: string;
let source: Source;
let linkCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-article-create-retry", name: "Test Article Create Retry", order: 999 },
  });
  categoryId = category.id;

  source = await prisma.source.create({
    data: {
      name: "Test Article Create Retry Source",
      url: "https://article-create-retry-test.example.com/feed.xml",
      categorySlug: "test-article-create-retry",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

function makeItem(suffix: string): FeedItem {
  linkCounter += 1;
  return {
    link: `https://article-create-retry-test.example.com/articles/${suffix}-${linkCounter}`,
    title: `Article create retry test article ${linkCounter}`,
    isoDate: new Date().toISOString(),
  };
}

function prismaError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Spies on the real prisma.article.create, letting each call's behavior be overridden by index (0-based), falling through to the real implementation for any call beyond the supplied overrides. */
function spyOnArticleCreate(
  overrides: Array<"P1008" | "P2024" | "P2002" | "UNKNOWN" | "passthrough">,
) {
  const original = prisma.article.create.bind(prisma.article);
  let callCount = 0;
  const spy = vi.spyOn(prisma.article, "create").mockImplementation(((args: unknown) => {
    const index = callCount;
    callCount += 1;
    const behavior = overrides[index] ?? "passthrough";
    switch (behavior) {
      case "P1008":
        return Promise.reject(prismaError("P1008", "simulated socket timeout"));
      case "P2024":
        return Promise.reject(prismaError("P2024", "simulated connection pool timeout"));
      case "P2002":
        return Promise.reject(prismaError("P2002", "simulated unique constraint violation"));
      case "UNKNOWN":
        return Promise.reject(new Error("simulated unknown failure"));
      case "passthrough":
        return (original as (args: unknown) => unknown)(args) as Promise<unknown>;
    }
  }) as unknown as typeof prisma.article.create);
  return { spy, callCount: () => callCount };
}

describe("createArticleWithRetry via persistItems: transient failures recover", () => {
  it("retries once and succeeds after a single P1008, persisting exactly one article", async () => {
    const item = makeItem("p1008-then-success");
    const { callCount } = spyOnArticleCreate(["P1008", "passthrough"]);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(1);
    expect(callCount()).toBe(2);

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(item.link!)) },
    });
    expect(article).not.toBeNull();
  }, 10_000);

  it("retries once and succeeds after a single P2024, persisting exactly one article", async () => {
    const item = makeItem("p2024-then-success");
    const { callCount } = spyOnArticleCreate(["P2024", "passthrough"]);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(1);
    expect(callCount()).toBe(2);

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(item.link!)) },
    });
    expect(article).not.toBeNull();
  }, 10_000);
});

describe("createArticleWithRetry via persistItems: bounded retries, never retries permanent errors", () => {
  it("exhausts its bounded retries on persistent P1008, makes exactly 3 attempts, and never persists the article", async () => {
    const item = makeItem("p1008-exhausted");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { callCount } = spyOnArticleCreate(["P1008", "P1008", "P1008"]);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(0); // never counted as new — it was never actually persisted
    expect(callCount()).toBe(3); // ARTICLE_CREATE_RETRY_DELAYS_MS has 2 entries -> 3 total attempts

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(item.link!)) },
    });
    expect(article).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled(); // the exhausted failure IS surfaced, not silently swallowed
  }, 10_000);

  it("never retries a first-attempt P2002 (ordinary concurrent-source race), leaving it for persistItems' existing dedupe skip", async () => {
    const item = makeItem("p2002-first-attempt");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { callCount } = spyOnArticleCreate(["P2002"]);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(0);
    expect(callCount()).toBe(1); // no retry attempt at all
    // Skipped silently as an ordinary dedupe race — never logged as an error.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  }, 10_000);

  it("never retries an unknown/non-Prisma error", async () => {
    const item = makeItem("unknown-error");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { callCount } = spyOnArticleCreate(["UNKNOWN"]);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(0);
    expect(callCount()).toBe(1); // no retry attempt at all
    expect(consoleErrorSpy).toHaveBeenCalled(); // unlike P2002, this IS an unexpected failure worth logging

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(item.link!)) },
    });
    expect(article).toBeNull();
  }, 10_000);
});

describe("createArticleWithRetry via persistItems: lost-acknowledgment idempotency", () => {
  it("recovers the actually-created row on a post-timeout P2002 instead of retrying again or creating a duplicate", async () => {
    const item = makeItem("lost-ack-recovery");
    const urlHash = hashUrl(normalizeUrl(item.link!));
    const original = prisma.article.create.bind(prisma.article);
    let callCount = 0;

    // First attempt: the INSERT genuinely commits (via the real `original`
    // call), but the caller is told P1008 anyway — simulating a lost
    // acknowledgment (Prisma itself never confirmed success in time). The
    // second attempt then hits the database's OWN real P2002 on the same
    // urlHash, since the row genuinely already exists — this is never
    // simulated, it's the actual SQLite unique-constraint violation.
    vi.spyOn(prisma.article, "create").mockImplementation((async (
      args: Parameters<typeof original>[0],
    ) => {
      callCount += 1;
      if (callCount === 1) {
        await original(args);
        throw prismaError("P1008", "simulated lost acknowledgment");
      }
      return original(args);
    }) as unknown as typeof prisma.article.create);

    const result = await persistItems(source, [item]);

    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(1); // recovered, not dropped
    expect(callCount).toBe(2);

    // Exactly ONE row exists for this urlHash — no duplicate was created.
    const articles = await prisma.article.findMany({ where: { urlHash } });
    expect(articles).toHaveLength(1);
  }, 10_000);
});
