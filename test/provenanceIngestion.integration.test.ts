import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { persistItems } from "@/lib/ingest/ingestSource";
import type { FeedItem } from "@/lib/ingest/fetchFeed";
import {
  EXTRACTOR_VERSION,
  clearStaleObservations,
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";

let categoryId: string;
let sourceId: string;
let source: Awaited<ReturnType<typeof prisma.source.create>>;

beforeAll(async () => {
  // This test DB is created fresh from migrations only (test/global-setup.ts
  // never runs the seed script), so the small provenance alias table this
  // suite depends on (Reuters, AP, DOJ, FBI) must be seeded here — the same
  // idempotent seedProvenanceEntities() the real app uses.
  await seedProvenanceEntities(prisma);

  const category = await prisma.category.create({
    data: { slug: "test-provenance-world", name: "Test Provenance World", order: 999 },
  });
  categoryId = category.id;

  source = await prisma.source.create({
    data: {
      name: "Test Provenance Source",
      url: "https://provenance-test.example.com/feed.xml",
      categorySlug: "test-provenance-world",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

function makeItem(overrides: Partial<FeedItem> & { link: string; title: string }): FeedItem {
  return {
    isoDate: new Date().toISOString(),
    ...overrides,
  } as FeedItem;
}

describe("46/47. new-ingestion extraction sees fuller sanitized feed text, not just the 220-char excerpt", () => {
  it("detects attribution appearing after character 220 but within the fuller feed text", async () => {
    const filler = "This is unrelated filler text about the weather today. ".repeat(6); // > 220 chars
    expect(filler.length).toBeGreaterThan(220);
    const content = `${filler}According to a court filing, the case was dismissed.`;

    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/after-220",
        title: "Local weather report",
        content,
      }),
    ];

    const result = await persistItems(source, items);
    expect(result.itemsNew).toBe(1);

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: true },
    });
    expect(article).not.toBeNull();

    // 48. Article.excerpt remains capped at the existing 220-char behavior.
    expect(article!.excerpt!.length).toBeLessThanOrEqual(221);

    // The attribution phrase starts well after character 220 in the full
    // feed text, so it could never have been found in the stored excerpt
    // alone — proving extraction saw the fuller pre-truncation text.
    const feedTextObservation = article!.provenanceObservations.find(
      (o) => o.extractionSource === "FEED_TEXT",
    );
    expect(feedTextObservation).toBeDefined();
    expect(feedTextObservation!.startOffset).toBeGreaterThan(220);
    expect(feedTextObservation!.evidenceType).toBe("COURT_FILING");
  });

  it("49. the full feed text is never itself stored anywhere — only the bounded evidence snippet survives", async () => {
    const filler = "Unrelated background context sentence goes here. ".repeat(10);
    const content = `${filler}Reuters reported the deal closed on Friday.`;
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/no-full-text-stored",
        title: "Deal news",
        content,
      }),
    ];
    await persistItems(source, items);

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: true },
    });
    expect(article!.excerpt).not.toContain(filler.trim());
    for (const obs of article!.provenanceObservations) {
      expect(obs.evidenceText.length).toBeLessThanOrEqual(201);
      expect(obs.evidenceText).not.toBe(content);
    }
  });

  it("50. extraction/persistence still leaves the Article intact even when there is no attributable text at all", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/no-attribution",
        title: "A perfectly ordinary headline with nothing notable",
        content: "Nothing about sourcing appears in this text at all.",
      }),
    ];
    const result = await persistItems(source, items);
    expect(result.itemsNew).toBe(1);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: true },
    });
    expect(article).not.toBeNull();
    expect(article!.provenanceObservations).toHaveLength(0);
  });

  it("title-only attribution is captured with extractionSource TITLE, distinct from feed-text observations", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/title-attribution",
        title: "Reuters reported the merger is complete",
        content: "No attribution language here.",
      }),
    ];
    await persistItems(source, items);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: true },
    });
    expect(article!.provenanceObservations).toHaveLength(1);
    expect(article!.provenanceObservations[0].extractionSource).toBe("TITLE");
  });

  it("39/16. a MEDIUM observation persists but a LOW one never reaches the database", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/low-confidence",
        title: "Sources said the deal was near collapse",
        content: "No further detail provided.",
      }),
    ];
    await persistItems(source, items);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: true },
    });
    // "Sources said" is deliberately LOW in the extractor — it must never
    // reach the database, so this article has zero persisted observations
    // despite the extractor recognizing a candidate internally.
    expect(article!.provenanceObservations).toHaveLength(0);
  });
});

describe("57/58. database relationships and cascade behavior", () => {
  it("57. deleting an Article cascades its ProvenanceObservations", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/cascade-test",
        title: "Reuters reported the story",
      }),
    ];
    await persistItems(source, items);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
    });
    const before = await prisma.provenanceObservation.count({ where: { articleId: article!.id } });
    expect(before).toBeGreaterThan(0);

    await prisma.article.delete({ where: { id: article!.id } });
    const after = await prisma.provenanceObservation.count({ where: { articleId: article!.id } });
    expect(after).toBe(0);
  });

  it("58. an observation's resolved entity relation is queryable both ways, and surviving an entity delete sets entityId null (not a cascade delete)", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/entity-relation-test",
        title: "Reuters reported the story",
      }),
    ];
    await persistItems(source, items);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
      include: { provenanceObservations: { include: { entity: true } } },
    });
    const obs = article!.provenanceObservations[0];
    expect(obs.entity?.canonicalName).toBe("Reuters");

    const entityObservations = await prisma.provenanceObservation.findMany({
      where: { entityId: obs.entityId! },
    });
    expect(entityObservations.some((o) => o.id === obs.id)).toBe(true);
  });
});

describe("59. alias uniqueness", () => {
  it("a duplicate normalizedAlias is rejected by the unique constraint", async () => {
    const reuters = await prisma.provenanceEntity.findUnique({
      where: { canonicalName: "Reuters" },
    });
    expect(reuters).not.toBeNull();

    await expect(
      prisma.provenanceAlias.create({
        data: {
          entityId: reuters!.id,
          aliasText: "Reuters",
          normalizedAlias: "reuters",
          matchType: "CASE_INSENSITIVE",
          source: "LEARNED",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("54/60. idempotency — repeated extraction never duplicates observations", () => {
  it("running persistObservationsForArticle twice for the same article/version produces no duplicate rows", async () => {
    const items = [
      makeItem({
        link: "https://provenance-test.example.com/articles/idempotent-test",
        title: "A headline with no attribution",
      }),
    ];
    await persistItems(source, items);
    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(items[0].link!)) },
    });

    const aliasIndex = await loadAliasIndex(prisma);
    const text = "Reuters reported the story again.";
    await persistObservationsForArticle(prisma, {
      articleId: article!.id,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: source.name,
      aliasIndex,
    });
    const firstCount = await prisma.provenanceObservation.count({
      where: { articleId: article!.id },
    });

    // Rerun with the identical input — must not create a second row.
    await persistObservationsForArticle(prisma, {
      articleId: article!.id,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: source.name,
      aliasIndex,
    });
    const secondCount = await prisma.provenanceObservation.count({
      where: { articleId: article!.id },
    });

    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBe(firstCount);
  });
});

describe("51/52/55/56. reprocessing/versioning and honest backfill labeling", () => {
  it("51/52. backfill-style extraction against stored excerpt only uses STORED_EXCERPT_BACKFILL, never FEED_TEXT", async () => {
    const article = await prisma.article.create({
      data: {
        sourceId,
        url: "https://provenance-test.example.com/articles/backfill-honesty",
        urlHash: hashUrl(
          normalizeUrl("https://provenance-test.example.com/articles/backfill-honesty"),
        ),
        title: "A historical headline",
        titleNormalized: "a historical headline",
        excerpt: "According to court records, the case was dismissed years ago.",
        publishedAt: new Date(),
        categoryId,
      },
    });

    const aliasIndex = await loadAliasIndex(prisma);
    const result = await persistObservationsForArticle(prisma, {
      articleId: article.id,
      text: article.excerpt!,
      extractionSource: "STORED_EXCERPT_BACKFILL",
      publisherName: source.name,
      aliasIndex,
    });
    expect(result.persisted).toBeGreaterThan(0);

    const observations = await prisma.provenanceObservation.findMany({
      where: { articleId: article.id },
    });
    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      expect(obs.extractionSource).toBe("STORED_EXCERPT_BACKFILL");
      expect(obs.extractionSource).not.toBe("FEED_TEXT");
    }
  });

  it("55. reprocessing at a new extractor version replaces stale rows from an old version", async () => {
    const article = await prisma.article.create({
      data: {
        sourceId,
        url: "https://provenance-test.example.com/articles/version-test",
        urlHash: hashUrl(normalizeUrl("https://provenance-test.example.com/articles/version-test")),
        title: "Reuters reported the outcome",
        titleNormalized: "reuters reported the outcome",
        publishedAt: new Date(),
        categoryId,
      },
    });

    const aliasIndex = await loadAliasIndex(prisma);
    await persistObservationsForArticle(prisma, {
      articleId: article.id,
      text: article.title,
      extractionSource: "TITLE",
      publisherName: source.name,
      aliasIndex,
      extractorVersion: "attribution-regex@old-test-version",
    });
    const staleCount = await prisma.provenanceObservation.count({
      where: { articleId: article.id, extractorVersion: "attribution-regex@old-test-version" },
    });
    expect(staleCount).toBeGreaterThan(0);

    const removed = await clearStaleObservations(prisma, article.id, EXTRACTOR_VERSION);
    expect(removed).toBe(staleCount);

    await persistObservationsForArticle(prisma, {
      articleId: article.id,
      text: article.title,
      extractionSource: "TITLE",
      publisherName: source.name,
      aliasIndex,
    });

    const remainingOld = await prisma.provenanceObservation.count({
      where: { articleId: article.id, extractorVersion: "attribution-regex@old-test-version" },
    });
    const currentCount = await prisma.provenanceObservation.count({
      where: { articleId: article.id, extractorVersion: EXTRACTOR_VERSION },
    });
    expect(remainingOld).toBe(0);
    expect(currentCount).toBeGreaterThan(0);
  });

  it("56. an ADMIN_OVERRIDE observation survives clearStaleObservations even at an old version", async () => {
    const article = await prisma.article.create({
      data: {
        sourceId,
        url: "https://provenance-test.example.com/articles/admin-override-test",
        urlHash: hashUrl(
          normalizeUrl("https://provenance-test.example.com/articles/admin-override-test"),
        ),
        title: "A headline an admin manually annotated",
        titleNormalized: "a headline an admin manually annotated",
        publishedAt: new Date(),
        categoryId,
      },
    });

    const manual = await prisma.provenanceObservation.create({
      data: {
        articleId: article.id,
        rawEntityText: "Manually corrected entity",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "HIGH",
        evidenceText: "manually reviewed evidence",
        extractionSource: "TITLE",
        startOffset: 0,
        endOffset: 10,
        extractorVersion: "attribution-regex@ancient-version",
        reviewState: "ADMIN_OVERRIDE",
        dedupeKey: "test-admin-override-dedupe-key",
      },
    });

    const removed = await clearStaleObservations(prisma, article.id, EXTRACTOR_VERSION);
    expect(removed).toBe(0);

    const stillThere = await prisma.provenanceObservation.findUnique({ where: { id: manual.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.reviewState).toBe("ADMIN_OVERRIDE");
  });
});
