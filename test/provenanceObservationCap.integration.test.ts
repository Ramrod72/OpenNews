import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  EXTRACTOR_VERSION,
  MAX_OBSERVATIONS_PER_ARTICLE,
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";
import { seedProvenanceEntities } from "../prisma/seedProvenanceEntities";
import type { AliasIndex } from "@/lib/provenance/entityResolution";

/**
 * Phase 8B: adversarial + deterministic tests for the defensive
 * MAX_OBSERVATIONS_PER_ARTICLE cap added to persistObservationsForArticle
 * (see src/lib/provenance/persistObservations.ts). These specifically
 * target scenarios P, Q, R, S from the Phase 8B spec: a malicious flood of
 * repeated attribution phrases, an exactly-one-over-the-limit legitimate
 * case, HIGH-vs-MEDIUM deterministic prioritization when both compete for
 * the last slots, and ADMIN_OVERRIDE survival through the cap.
 */

let categoryId: string;
let sourceId: string;
let aliasIndex: AliasIndex;
let articleCounter = 0;

beforeAll(async () => {
  await seedProvenanceEntities(prisma);
  aliasIndex = await loadAliasIndex(prisma);

  const category = await prisma.category.create({
    data: { slug: "test-provenance-cap", name: "Test Provenance Cap", order: 999 },
  });
  categoryId = category.id;

  const source = await prisma.source.create({
    data: {
      name: "Test Provenance Cap Source",
      url: "https://provenance-cap-test.example.com/feed.xml",
      categorySlug: "test-provenance-cap",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  await prisma.provenanceObservation.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeArticle(): Promise<string> {
  articleCounter += 1;
  const url = `https://provenance-cap-test.example.com/article-${articleCounter}`;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url,
      urlHash: hashUrl(normalizeUrl(url)),
      title: `Cap test article ${articleCounter}`,
      titleNormalized: `cap test article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

/** Every sentence contains exactly one non-overlapping "police said" match (MEDIUM, CITES_STATEMENT, no entity resolution). */
function policeSaidFlood(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `Police said incident number ${i} occurred near downtown today.`,
  ).join(" ");
}

/** Every sentence contains exactly one non-overlapping "Reuters reported" match (HIGH, CITES_WIRE_SERVICE). */
function reutersSentence(i: number): string {
  return `Reuters reported update number ${i} about the ongoing situation.`;
}

describe("Phase 8B — P: malicious repeated-attribution flood is capped at 20", () => {
  it("persists at most MAX_OBSERVATIONS_PER_ARTICLE even with hundreds of repeated phrases", async () => {
    const articleId = await makeArticle();
    const text = policeSaidFlood(500);

    const result = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });

    expect(result.discardedLow).toBe(0);
    expect(result.persisted).toBe(MAX_OBSERVATIONS_PER_ARTICLE);
    expect(result.cappedByLimit).toBe(500 - MAX_OBSERVATIONS_PER_ARTICLE);

    const rows = await prisma.provenanceObservation.findMany({ where: { articleId } });
    expect(rows).toHaveLength(MAX_OBSERVATIONS_PER_ARTICLE);
    expect(rows.every((r) => r.reviewState !== "ADMIN_OVERRIDE")).toBe(true);
  });

  it("still allows article ingestion (this call itself) to succeed without throwing, even when capped", async () => {
    const articleId = await makeArticle();
    const text = policeSaidFlood(2000);
    await expect(
      persistObservationsForArticle(prisma, {
        articleId,
        text,
        extractionSource: "FEED_TEXT",
        publisherName: "Test Provenance Cap Source",
        aliasIndex,
      }),
    ).resolves.toBeDefined();
  });
});

describe("Phase 8B — Q: exactly 21 legitimate observations capped at 20 deterministically", () => {
  it("keeps exactly the first 20 (by textual order) and drops the 21st, and is stable across reruns", async () => {
    const articleId = await makeArticle();
    const text = policeSaidFlood(21);

    // Independently (black-box) compute every "Police said" occurrence
    // offset in the source text, so the expected kept set doesn't rely on
    // any internal extractor detail.
    const allOffsets = [...text.matchAll(/Police said/g)].map((m) => m.index!);
    expect(allOffsets).toHaveLength(21);
    const expectedKept = new Set(allOffsets.slice(0, 20));
    const expectedDropped = allOffsets[20];

    const first = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });
    expect(first.persisted).toBe(20);
    expect(first.cappedByLimit).toBe(1);

    const rowsAfterFirst = await prisma.provenanceObservation.findMany({
      where: { articleId },
      select: { startOffset: true },
    });
    const keptOffsets = new Set(rowsAfterFirst.map((r) => r.startOffset));
    expect(keptOffsets).toEqual(expectedKept);
    expect(keptOffsets.has(expectedDropped)).toBe(false);

    // Rerun with the identical text: idempotent — same 20 rows, no drift,
    // nothing newly dropped or newly added.
    const second = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });
    expect(second.persisted).toBe(20);
    expect(second.cappedByLimit).toBe(1);

    const rowsAfterSecond = await prisma.provenanceObservation.findMany({
      where: { articleId },
      select: { startOffset: true },
    });
    expect(new Set(rowsAfterSecond.map((r) => r.startOffset))).toEqual(expectedKept);
    expect(rowsAfterSecond).toHaveLength(20);
  });
});

describe("Phase 8B — R: HIGH observations are never dropped in favor of MEDIUM ones beyond the cap", () => {
  it("keeps all HIGH candidates plus the earliest MEDIUM candidates that fit the remaining budget", async () => {
    const articleId = await makeArticle();

    // 5 HIGH (Reuters) sentences scattered among 20 MEDIUM (police)
    // sentences — total 25 candidates, cap 20. HIGH must never lose a
    // slot to MEDIUM regardless of textual position.
    const sentences: string[] = [];
    let reutersIndex = 0;
    for (let i = 0; i < 25; i++) {
      if (i % 5 === 3) {
        sentences.push(reutersSentence(reutersIndex));
        reutersIndex += 1;
      } else {
        sentences.push(`Police said event number ${i} was reported near the scene.`);
      }
    }
    const text = sentences.join(" ");
    expect(reutersIndex).toBe(5);

    const allPoliceOffsets = [...text.matchAll(/Police said/g)].map((m) => m.index!);
    expect(allPoliceOffsets).toHaveLength(20);
    const expectedKeptPoliceOffsets = new Set(allPoliceOffsets.slice(0, 15));

    const result = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });
    expect(result.persisted).toBe(20);
    expect(result.cappedByLimit).toBe(5);

    const rows = await prisma.provenanceObservation.findMany({ where: { articleId } });
    const wireServiceRows = rows.filter((r) => r.relationshipType === "CITES_WIRE_SERVICE");
    const statementRows = rows.filter((r) => r.relationshipType === "CITES_STATEMENT");

    expect(wireServiceRows).toHaveLength(5);
    expect(wireServiceRows.every((r) => r.confidence === "HIGH")).toBe(true);
    expect(statementRows).toHaveLength(15);
    expect(new Set(statementRows.map((r) => r.startOffset))).toEqual(expectedKeptPoliceOffsets);
  });
});

describe("Phase 8B — S: ADMIN_OVERRIDE rows survive the cap and are never touched by it", () => {
  it("never deletes, destabilizes, or counts a pre-existing ADMIN_OVERRIDE row against the auto-generated budget", async () => {
    const articleId = await makeArticle();
    const text = policeSaidFlood(25);

    const firstRun = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });
    expect(firstRun.persisted).toBe(20);
    expect(firstRun.cappedByLimit).toBe(5);

    // Simulate an admin manually reviewing/adding a corrected observation
    // for this article — a row a future admin UI would create, marked
    // ADMIN_OVERRIDE from the start, at an offset the flood text never
    // produces a candidate for.
    const adminRow = await prisma.provenanceObservation.create({
      data: {
        articleId,
        entityId: null,
        rawEntityText: "manually corrected source",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "HIGH",
        evidenceText: "manually corrected source",
        extractionSource: "FEED_TEXT",
        startOffset: 999999,
        endOffset: 999999 + "manually corrected source".length,
        extractorVersion: EXTRACTOR_VERSION,
        reviewState: "ADMIN_OVERRIDE",
        dedupeKey: `admin-override-${articleId}`,
      },
    });

    // Re-run extraction on the same text (as reprocessing/backfill would).
    const secondRun = await persistObservationsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      publisherName: "Test Provenance Cap Source",
      aliasIndex,
    });

    // The 20 auto rows are unchanged (idempotent no-op re-upsert); the
    // ADMIN_OVERRIDE row never counted against their budget, so nothing
    // new is silently squeezed in and nothing existing is evicted.
    expect(secondRun.persisted).toBe(20);
    expect(secondRun.cappedByLimit).toBe(5);

    const allRows = await prisma.provenanceObservation.findMany({ where: { articleId } });
    expect(allRows).toHaveLength(21); // 20 auto + 1 admin override
    const autoRows = allRows.filter((r) => r.reviewState !== "ADMIN_OVERRIDE");
    const overrideRows = allRows.filter((r) => r.reviewState === "ADMIN_OVERRIDE");
    expect(autoRows).toHaveLength(20);
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0]!.id).toBe(adminRow.id);
    expect(overrideRows[0]!.rawEntityText).toBe("manually corrected source");
  });
});

describe("Phase 8B adversarial review — L: concurrent calls for the same article never collectively exceed the cap", () => {
  it("two concurrent persistObservationsForArticle calls for the same article/version stay within the cap (e.g. an overlapping live-ingestion + manually-triggered backfill touching the same article)", async () => {
    const articleId = await makeArticle();

    // Two DIFFERENT extraction sources (as a real overlap would produce),
    // each independently under the cap (15 < 20), but together (30) would
    // overshoot it if the budget check weren't transactionally atomic with
    // the writes that consume it.
    const [r1, r2] = await Promise.all([
      persistObservationsForArticle(prisma, {
        articleId,
        text: policeSaidFlood(15),
        extractionSource: "FEED_TEXT",
        publisherName: "Test Provenance Cap Source",
        aliasIndex,
      }),
      persistObservationsForArticle(prisma, {
        articleId,
        text: policeSaidFlood(15).replace(/incident number (\d+)/g, "incident case $1"), // distinct offsets/text so dedupeKeys differ from the first call
        extractionSource: "TITLE",
        publisherName: "Test Provenance Cap Source",
        aliasIndex,
      }),
    ]);

    const rows = await prisma.provenanceObservation.findMany({ where: { articleId } });
    expect(rows.length).toBeLessThanOrEqual(MAX_OBSERVATIONS_PER_ARTICLE);
    expect(r1.persisted + r2.persisted).toBe(rows.length);
  });
});
