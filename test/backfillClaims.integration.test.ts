import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CLAIM_EXTRACTOR_VERSION, persistClaimsForArticle } from "@/lib/claims/persistClaims";

let categoryId: string;
let sourceId: string;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-backfill-claims", name: "Test Backfill Claims", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test Backfill Claims Source",
      url: "https://backfill-claims-test.example.com/feed.xml",
      categorySlug: "test-backfill-claims",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeArticle(title: string, excerpt: string | null): Promise<string> {
  articleCounter += 1;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url: `https://backfill-claims-test.example.com/a${articleCounter}`,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title,
      titleNormalized: title.toLowerCase(),
      excerpt,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

describe("historical extraction source labeling", () => {
  it("extractionSource is TITLE and STORED_EXCERPT_BACKFILL, never FEED_TEXT, for backfilled claims", async () => {
    const articleId = await makeArticle(
      "12 people were injured in the fire",
      "Officials said 5 people were killed in the blast.",
    );

    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured in the fire",
      extractionSource: "TITLE",
      observations: [],
    });
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "Officials said 5 people were killed in the blast.",
      extractionSource: "STORED_EXCERPT_BACKFILL",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    const sources = new Set(rows.map((r) => r.extractionSource));
    expect(sources.has("FEED_TEXT")).toBe(false);
    expect(sources).toEqual(new Set(["TITLE", "STORED_EXCERPT_BACKFILL"]));
  });

  it("produces zero claims for an article with no excerpt (title-only backfill)", async () => {
    const articleId = await makeArticle("No excerpt article", null);
    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text: "No excerpt article",
      extractionSource: "TITLE",
      observations: [],
    });
    // No numerical/attributed pattern in this plain title — zero claims,
    // not an error.
    expect(result.persisted).toBe(0);
  });
});

describe("dry-run and idempotency (mirroring backfill-provenance.ts's own tested contract)", () => {
  it("running persistClaimsForArticle twice for the same article/version produces no duplicate rows", async () => {
    const articleId = await makeArticle(
      "12 people were injured",
      "12 people were injured in the fire.",
    );
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured",
      extractionSource: "TITLE",
      observations: [],
      claimExtractorVersion: CLAIM_EXTRACTOR_VERSION,
    });
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured",
      extractionSource: "TITLE",
      observations: [],
      claimExtractorVersion: CLAIM_EXTRACTOR_VERSION,
    });
    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(1);
  });
});

describe("cursor-based batching shape (structural check on the script itself)", () => {
  it("worker/backfill-claims.ts uses orderBy id asc + cursor/skip, matching backfill-provenance.ts's pattern", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(__dirname, "..", "worker/backfill-claims.ts"), "utf8");
    expect(source).toMatch(/orderBy:\s*\{\s*id:\s*"asc"\s*\}/);
    expect(source).toMatch(/--dry-run/);
    expect(source).toMatch(/--after=/);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/FEED_TEXT["'],?\s*$/m); // never claims FEED_TEXT as a literal extractionSource
  });
});

describe("no network access from claim backfill", () => {
  it("persistClaimsForArticle never calls fetch", async () => {
    const articleId = await makeArticle("12 people were injured", null);
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = ((...args: unknown[]) => {
      fetchCalled = true;
      throw new Error(`unexpected fetch: ${JSON.stringify(args)}`);
    }) as typeof global.fetch;
    try {
      await persistClaimsForArticle(prisma, {
        articleId,
        text: "12 people were injured",
        extractionSource: "TITLE",
        observations: [],
      });
    } finally {
      global.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);
  });
});
