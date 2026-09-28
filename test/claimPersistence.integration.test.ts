import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  CLAIM_EXTRACTOR_VERSION,
  MAX_CLAIMS_PER_ARTICLE,
  clearStaleClaims,
  persistClaimsForArticle,
} from "@/lib/claims/persistClaims";

let categoryId: string;
let sourceId: string;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-claim-persistence", name: "Test Claim Persistence", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test Claim Persistence Source",
      url: "https://claim-persistence-test.example.com/feed.xml",
      categorySlug: "test-claim-persistence",
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

async function makeArticle(): Promise<string> {
  articleCounter += 1;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url: `https://claim-persistence-test.example.com/a${articleCounter}`,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title: `Test article ${articleCounter}`,
      titleNormalized: `test article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

describe("basic persistence and dedupe", () => {
  it("persists a numerical claim and is idempotent across repeated calls", async () => {
    const articleId = await makeArticle();
    const text = "Officials said 12 people were injured in the fire.";

    const first = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(first.persisted).toBe(1);

    // persisted counts successful upsert operations (mirroring
    // persistObservationsForArticle's own semantics exactly) — a rerun
    // against the same dedupeKey re-upserts (a no-op `update: {}`) rather
    // than inserting a new row, so the ROW COUNT is what proves idempotency,
    // not the persisted counter.
    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(1);
  });

  it("does not dedupe two genuinely distinct claims at different offsets", async () => {
    const articleId = await makeArticle();
    const text = "5 people were killed in one incident. 12 people were injured in another.";
    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(result.persisted).toBe(2);
  });
});

describe("MAX_CLAIMS_PER_ARTICLE cap", () => {
  it("caps total persisted claims at MAX_CLAIMS_PER_ARTICLE across multiple calls for the same article", async () => {
    const articleId = await makeArticle();
    // 30 distinct numerical claims across 30 sentences — well over the cap.
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");

    await persistClaimsForArticle(prisma, {
      articleId,
      text: sentences,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
  });

  it("prioritizes HIGH confidence claims over MEDIUM when the cap forces a choice", async () => {
    const articleId = await makeArticle();
    // 15 HIGH-confidence INJURIES claims + 15 MEDIUM-confidence bare PEOPLE claims = 30 candidates, cap is 20.
    const injuries = Array.from({ length: 15 }, (_, i) => `${i + 1} people were injured today.`);
    const bare = Array.from(
      { length: 15 },
      (_, i) => `About ${i + 100} people attended event ${i}.`,
    );
    const text = [...injuries, ...bare].join(" ");

    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
    const highCount = rows.filter((r) => r.confidence === "HIGH").length;
    expect(highCount).toBe(15); // every HIGH candidate survives the cap
  });

  it("never drops previously-persisted rows when a later call is itself at/over the cap (idempotent re-upsert, not overwrite)", async () => {
    const articleId = await makeArticle();
    const firstBatch = Array.from(
      { length: 20 },
      (_, i) => `${i + 1} people were injured today.`,
    ).join(" ");
    await persistClaimsForArticle(prisma, {
      articleId,
      text: firstBatch,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const afterFirst = await prisma.claim.count({ where: { articleId } });
    expect(afterFirst).toBe(20);

    // A second, different-text call (simulating TITLE) should be capped to zero new rows.
    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text: "999 people were injured elsewhere.",
      extractionSource: "TITLE",
      observations: [],
    });
    expect(result.cappedByLimit).toBeGreaterThan(0);
    const afterSecond = await prisma.claim.count({ where: { articleId } });
    expect(afterSecond).toBe(20); // unchanged — the cap held, nothing was displaced
  });
});

describe("concurrency safety (the exact race Phase 8 previously had to fix)", () => {
  it("two concurrent persist calls for the SAME article/version never collectively exceed the cap", async () => {
    const articleId = await makeArticle();
    const textA = Array.from(
      { length: 15 },
      (_, i) => `${i + 1} people were injured in fire ${i}.`,
    ).join(" ");
    const textB = Array.from(
      { length: 15 },
      (_, i) => `${i + 50} people were injured in flood ${i}.`,
    ).join(" ");

    await Promise.all([
      persistClaimsForArticle(prisma, {
        articleId,
        text: textA,
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
      persistClaimsForArticle(prisma, {
        articleId,
        text: textB,
        extractionSource: "TITLE",
        observations: [],
      }),
    ]);

    const rows = await prisma.claim.count({ where: { articleId } });
    expect(rows).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
  });
});

describe("ADMIN_OVERRIDE preservation", () => {
  it("clearStaleClaims never deletes an ADMIN_OVERRIDE row regardless of its version", async () => {
    const articleId = await makeArticle();
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured.",
      extractionSource: "FEED_TEXT",
      observations: [],
      claimExtractorVersion: "stale-version@0",
    });
    const claim = await prisma.claim.findFirstOrThrow({ where: { articleId } });
    await prisma.claim.update({ where: { id: claim.id }, data: { reviewState: "ADMIN_OVERRIDE" } });

    const deletedCount = await clearStaleClaims(prisma, articleId, CLAIM_EXTRACTOR_VERSION);
    expect(deletedCount).toBe(0);
    const stillThere = await prisma.claim.findUnique({ where: { id: claim.id } });
    expect(stillThere).not.toBeNull();
  });

  it("clearStaleClaims deletes a non-override row at a different version", async () => {
    const articleId = await makeArticle();
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured.",
      extractionSource: "FEED_TEXT",
      observations: [],
      claimExtractorVersion: "stale-version@0",
    });
    const deletedCount = await clearStaleClaims(prisma, articleId, CLAIM_EXTRACTOR_VERSION);
    expect(deletedCount).toBe(1);
  });
});

describe("hostile/malformed text never crashes persistence", () => {
  it("persists safely against hostile HTML/Unicode text", async () => {
    const articleId = await makeArticle();
    await expect(
      persistClaimsForArticle(prisma, {
        articleId,
        text: '<script>alert(1)</script> 12 people were injured "quotes" & ‮RTL‬.',
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
    ).resolves.toBeDefined();
  });

  it("bounds rawText/normalizedText length in the persisted row", async () => {
    const articleId = await makeArticle();
    const longSentence = `${"word ".repeat(300)}12 people were injured in the incident.`;
    await persistClaimsForArticle(prisma, {
      articleId,
      text: longSentence,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const rows = await prisma.claim.findMany({ where: { articleId } });
    for (const row of rows) {
      expect(row.rawText.length).toBeLessThanOrEqual(201);
    }
  });
});
