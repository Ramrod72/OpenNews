import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Regression coverage for linkKeywords' rewrite from a per-phrase
 * upsert() loop to a single pre-filter/batch pattern (the same write-
 * amplification fix PR #19 applied to persistClaims.ts/
 * persistObservations.ts, one level up — see ingestSource.ts's own doc
 * comment on linkKeywords for the full rationale).
 */

vi.mock("@/lib/nlp/keywords", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nlp/keywords")>();
  return { ...actual, extractKeywordPhrases: vi.fn(actual.extractKeywordPhrases) };
});

const { extractKeywordPhrases } = await import("@/lib/nlp/keywords");
const { linkKeywords } = await import("@/lib/ingest/ingestSource");
const extractKeywordPhrasesMock = extractKeywordPhrases as unknown as Mock;

let categoryId: string;
let sourceId: string;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-linkkeywords-batching", name: "Test LinkKeywords Batching", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test LinkKeywords Batching Source",
      url: "https://linkkeywords-batching-test.example.com/feed.xml",
      categorySlug: "test-linkkeywords-batching",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.keyword.deleteMany({ where: { term: { startsWith: "Test LinkKeywords" } } });
  await prisma.keyword.deleteMany({
    where: { term: { in: ["World Health Organization", "Acme Corp", "Unique Race Corp"] } },
  });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  extractKeywordPhrasesMock.mockClear();
  await prisma.articleKeyword.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeArticle(): Promise<string> {
  articleCounter += 1;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url: `https://linkkeywords-batching-test.example.com/a${articleCounter}`,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title: `Test article ${articleCounter}`,
      titleNormalized: `test article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

describe("basic linking", () => {
  it("links every real extracted phrase to a new article", async () => {
    const title = "The World Health Organization and the European Union meet today";
    const expectedPhrases = extractKeywordPhrases(title); // real extractor, unmocked

    const articleId = await makeArticle();
    await linkKeywords(articleId, title);

    const links = await prisma.articleKeyword.findMany({
      where: { articleId },
      include: { keyword: true },
    });
    expect(links.map((l) => l.keyword.term).sort()).toEqual([...expectedPhrases].sort());
    expect(links.every((l) => l.weight === 1)).toBe(true);
  });
});

describe("already-existing Keyword rows are reused, never duplicated", () => {
  it("links a second article to the SAME Keyword row rather than creating a duplicate", async () => {
    const title = "The World Health Organization issued new guidance";
    const articleA = await makeArticle();
    await linkKeywords(articleA, title);

    const keywordRowsAfterFirst = await prisma.keyword.findMany({
      where: { term: "World Health Organization" },
    });
    expect(keywordRowsAfterFirst).toHaveLength(1);
    const sharedKeywordId = keywordRowsAfterFirst[0]!.id;

    const articleB = await makeArticle();
    await linkKeywords(articleB, "World Health Organization warns of new outbreak");

    const keywordRowsAfterSecond = await prisma.keyword.findMany({
      where: { term: "World Health Organization" },
    });
    expect(keywordRowsAfterSecond).toHaveLength(1); // still exactly one row, not two
    expect(keywordRowsAfterSecond[0]!.id).toBe(sharedKeywordId);

    const linkB = await prisma.articleKeyword.findUnique({
      where: { articleId_keywordId: { articleId: articleB, keywordId: sharedKeywordId } },
    });
    expect(linkB).not.toBeNull();
  });
});

describe("idempotency", () => {
  it("calling linkKeywords twice for the same article never creates duplicate ArticleKeyword rows", async () => {
    const title = "Acme Corp announces quarterly results";
    const articleId = await makeArticle();

    await linkKeywords(articleId, title);
    const countAfterFirst = await prisma.articleKeyword.count({ where: { articleId } });

    await linkKeywords(articleId, title); // rerun with identical input
    const countAfterSecond = await prisma.articleKeyword.count({ where: { articleId } });

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(countAfterFirst).toBeGreaterThan(0);
  });
});

describe("intra-batch duplicate phrases are defensively deduplicated", () => {
  it("collapses repeated phrases within a single call's own candidate list to one Keyword and one link", async () => {
    extractKeywordPhrasesMock.mockReturnValueOnce(["Acme Corp", "Acme Corp", "Acme Corp"]);

    const articleId = await makeArticle();
    await linkKeywords(articleId, "irrelevant — extraction is mocked for this test");

    const keywordRows = await prisma.keyword.findMany({ where: { term: "Acme Corp" } });
    expect(keywordRows).toHaveLength(1); // a naive createMany of 3 identical terms would have thrown P2002 for the whole batch

    const links = await prisma.articleKeyword.findMany({ where: { articleId } });
    expect(links).toHaveLength(1);
    expect(links[0]!.keywordId).toBe(keywordRows[0]!.id);
  });
});

describe("concurrent-creation race on Keyword.term is recovered, not failed", () => {
  it("recovers via re-fetch when another process's Keyword row isn't visible to the initial lookup", async () => {
    const term = "Unique Race Corp";
    // Simulates a DIFFERENT, concurrently-ingesting source having already
    // created this exact term a moment before this call's own read.
    const existingKeyword = await prisma.keyword.create({ data: { term } });
    extractKeywordPhrasesMock.mockReturnValueOnce([term]);

    // Make linkKeywords' own initial existence check miss the row that
    // genuinely already exists (the race window) — its createMany then
    // hits a REAL unique-constraint violation, exercising the catch +
    // re-fetch recovery path for real, not a mocked error.
    vi.spyOn(prisma.keyword, "findMany").mockImplementationOnce((() =>
      Promise.resolve([])) as unknown as typeof prisma.keyword.findMany);

    const articleId = await makeArticle();
    await expect(linkKeywords(articleId, "irrelevant")).resolves.toBeUndefined();

    const keywordRows = await prisma.keyword.findMany({ where: { term } });
    expect(keywordRows).toHaveLength(1); // no duplicate row was created
    expect(keywordRows[0]!.id).toBe(existingKeyword.id);

    const link = await prisma.articleKeyword.findUnique({
      where: { articleId_keywordId: { articleId, keywordId: existingKeyword.id } },
    });
    expect(link).not.toBeNull(); // correctly linked to the pre-existing row, not a phantom duplicate
  });
});

describe("no phrases extracted", () => {
  it("is a safe no-op when extraction yields nothing, with no writes attempted", async () => {
    extractKeywordPhrasesMock.mockReturnValueOnce([]);
    const articleId = await makeArticle();
    await expect(linkKeywords(articleId, "irrelevant")).resolves.toBeUndefined();
    const links = await prisma.articleKeyword.findMany({ where: { articleId } });
    expect(links).toHaveLength(0);
  });
});
