import type { Source } from "@prisma/client";
import { prisma } from "@/lib/db";
import { safeImageUrl, toPlainText, truncatePlainText } from "@/lib/security/sanitize";
import { extractImageUrl, fetchAndParseFeed, FeedFetchError, type FeedItem } from "./fetchFeed";
import { hashUrl, normalizeTitle, normalizeUrl } from "./normalize";
import { extractKeywordPhrases } from "@/lib/nlp/keywords";
import {
  EXTRACTOR_VERSION,
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import type { AliasIndex } from "@/lib/provenance/entityResolution";
import { persistClaimsForArticle } from "@/lib/claims/persistClaims";
import type { AttributedStatementSourceObservation } from "@/lib/claims/buildAttributedStatementClaims";
import type { ProvenanceExtractionSource } from "@/lib/validation/provenance";

const RETRY_DELAYS_MS = [1000, 3000];

export interface IngestResult {
  sourceId: string;
  success: boolean;
  itemsFound: number;
  itemsNew: number;
  error?: string;
}

/** Fetch one source's feed, sanitize + dedupe its items, and persist new articles. */
export async function ingestSource(source: Source): Promise<IngestResult> {
  const startedAt = new Date();
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const feed = await fetchAndParseFeed(source.url);
      const result = await persistItems(source, feed.items ?? []);

      await prisma.$transaction([
        prisma.source.update({
          where: { id: source.id },
          data: {
            lastFetchedAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
            consecutiveFailures: 0,
          },
        }),
        prisma.feedFetchLog.create({
          data: {
            sourceId: source.id,
            startedAt,
            finishedAt: new Date(),
            success: true,
            itemsFound: result.itemsFound,
            itemsNew: result.itemsNew,
          },
        }),
      ]);

      return { sourceId: source.id, success: true, ...result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown error";
      const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
      if (!isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
    }
  }

  await prisma.$transaction([
    prisma.source.update({
      where: { id: source.id },
      data: {
        lastFetchedAt: new Date(),
        lastErrorAt: new Date(),
        lastError,
        consecutiveFailures: { increment: 1 },
      },
    }),
    prisma.feedFetchLog.create({
      data: {
        sourceId: source.id,
        startedAt,
        finishedAt: new Date(),
        success: false,
        itemsFound: 0,
        itemsNew: 0,
        errorMessage: lastError,
      },
    }),
  ]);

  return { sourceId: source.id, success: false, itemsFound: 0, itemsNew: 0, error: lastError };
}

async function persistItems(
  source: Source,
  items: FeedItem[],
): Promise<{ itemsFound: number; itemsNew: number }> {
  const category = await prisma.category.findUnique({ where: { slug: source.categorySlug } });
  // Loaded once per source fetch (not once per item) — the alias table is
  // small and shared across every article in this feed; see
  // ARCHITECTURE.md's Phase 7 performance notes.
  const aliasIndex = await loadAliasIndex(prisma);

  let itemsNew = 0;
  let itemsFound = 0;

  for (const item of items) {
    if (!item.link || !item.title) continue;
    itemsFound += 1;

    let normalized: string;
    try {
      normalized = normalizeUrl(item.link);
    } catch {
      continue; // malformed URL in feed — skip rather than fail the whole source
    }
    const urlHash = hashUrl(normalized);

    const existing = await prisma.article.findUnique({ where: { urlHash } });
    if (existing) continue;

    const title = toPlainText(item.title, 500);
    if (!title) continue;

    const rawExcerpt =
      item.contentSnippet || item.summary || item.content || item["content:encoded"];
    // Sanitized ONCE, to the existing 8000-char boundary — this is the
    // fuller transient text Phase 7B's provenance extraction analyzes
    // (see extractAndPersistProvenance below) before it's truncated to
    // the stored 220-char Article.excerpt. It is NEVER itself persisted
    // anywhere — only structured observations and small evidence
    // snippets survive (see ARCHITECTURE.md's Phase 7 section).
    const sanitizedFeedText = rawExcerpt ? toPlainText(rawExcerpt, 8000) : "";
    const publishedAt = parseDate(item.isoDate || item.pubDate) ?? new Date();

    try {
      const created = await prisma.article.create({
        data: {
          sourceId: source.id,
          url: normalized,
          urlHash,
          title,
          titleNormalized: normalizeTitle(title),
          excerpt: sanitizedFeedText ? truncatePlainText(sanitizedFeedText) : null,
          imageUrl: safeImageUrl(extractImageUrl(item)),
          author: item.creator ? toPlainText(item.creator, 200) : null,
          categoryId: category?.id,
          publishedAt,
          guid: item.guid ?? item.link,
        },
      });
      await linkKeywords(created.id, title);
      itemsNew += 1;
      // Runs AFTER the Article row exists and AFTER itemsNew is counted —
      // extraction/persistence failure must never prevent article
      // creation or be mistaken for one (see extractAndPersistProvenance's
      // own isolated try/catch below).
      await extractAndPersistProvenance(
        created.id,
        title,
        sanitizedFeedText,
        source.name,
        aliasIndex,
      );
      // Runs AFTER provenance extraction has persisted this article's
      // observations — ATTRIBUTED_STATEMENT claims are derived from those
      // already-persisted rows, never re-detected independently (see
      // extractAndPersistClaims's own doc comment). Isolated in its own
      // try/catch, separate from extractAndPersistProvenance's, so a
      // claims-specific failure can never be mistaken for — or interfere
      // with — provenance extraction, matching the same isolation
      // linkKeywords() and extractAndPersistProvenance() already apply.
      await extractAndPersistClaims(created.id, title, sanitizedFeedText);
    } catch (err) {
      // Unique constraint races (two sources sharing a syndicated URL fetched
      // concurrently) are expected and fine to skip; anything else, keep going.
      if (!isUniqueConstraintError(err)) {
        console.error(`[ingest] failed to store article from ${source.name}:`, err);
      }
    }
  }

  return { itemsFound, itemsNew };
}

/**
 * Runs the deterministic attribution extractor against this newly-created
 * article's title and (if present) its fuller sanitized feed text, then
 * persists any resulting HIGH/MEDIUM observations. Title and feed text are
 * genuinely separate text buffers with separate offset spaces, so each is
 * extracted and persisted as its own extractionSource ("TITLE" /
 * "FEED_TEXT") — never merged into one virtual buffer.
 *
 * Wrapped in its own try/catch, isolated from the caller: an unexpected
 * failure here (a bug, not just a DB write error — persistObservations.ts
 * already isolates per-observation write failures on its own) must never
 * propagate up and be mistaken for an article-creation failure, matching
 * the same isolation linkKeywords() already applies to keyword-linking.
 */
async function extractAndPersistProvenance(
  articleId: string,
  title: string,
  sanitizedFeedText: string,
  publisherName: string,
  aliasIndex: AliasIndex,
): Promise<void> {
  try {
    await persistObservationsForArticle(prisma, {
      articleId,
      text: title,
      extractionSource: "TITLE",
      publisherName,
      aliasIndex,
    });
    if (sanitizedFeedText) {
      await persistObservationsForArticle(prisma, {
        articleId,
        text: sanitizedFeedText,
        extractionSource: "FEED_TEXT",
        publisherName,
        aliasIndex,
      });
    }
  } catch (err) {
    console.error(`[ingest] provenance extraction failed for article ${articleId}:`, err);
  }
}

/**
 * Loads the current-extractorVersion (plus any ADMIN_OVERRIDE) Phase 7
 * observations just persisted for this article+extractionSource — the
 * same filter getClusterOriginSummary.ts already uses, kept identical here
 * so claim extraction and Phase 8's own reasoning never disagree about
 * which observations are "current." Bounded: at most
 * MAX_OBSERVATIONS_PER_ARTICLE (20) rows per extractionSource.
 */
async function loadCurrentObservationsForClaims(
  articleId: string,
  extractionSource: ProvenanceExtractionSource,
): Promise<AttributedStatementSourceObservation[]> {
  const rows = await prisma.provenanceObservation.findMany({
    where: {
      articleId,
      extractionSource,
      OR: [{ extractorVersion: EXTRACTOR_VERSION }, { reviewState: "ADMIN_OVERRIDE" }],
    },
    select: { entityId: true, startOffset: true, endOffset: true, confidence: true },
  });
  return rows.map((r) => ({
    entityId: r.entityId,
    startOffset: r.startOffset,
    endOffset: r.endOffset,
    confidence: r.confidence as "HIGH" | "MEDIUM",
  }));
}

/**
 * Runs Phase 10B's deterministic claim extraction (NUMERICAL_ASSERTION +
 * ATTRIBUTED_STATEMENT — see src/lib/claims/) against this newly-created
 * article's title and (if present) its fuller sanitized feed text, mirroring
 * extractAndPersistProvenance's own TITLE/FEED_TEXT split exactly.
 * ATTRIBUTED_STATEMENT claims are built from the Phase 7 observations
 * extractAndPersistProvenance already persisted for the SAME text buffer —
 * never independently re-detected (see buildAttributedStatementClaims.ts).
 *
 * Wrapped in its own try/catch, isolated from both the caller and from
 * provenance extraction: an unexpected failure here must never propagate
 * up and be mistaken for an article-creation or provenance-extraction
 * failure.
 */
async function extractAndPersistClaims(
  articleId: string,
  title: string,
  sanitizedFeedText: string,
): Promise<void> {
  try {
    const titleObservations = await loadCurrentObservationsForClaims(articleId, "TITLE");
    await persistClaimsForArticle(prisma, {
      articleId,
      text: title,
      extractionSource: "TITLE",
      observations: titleObservations,
    });
    if (sanitizedFeedText) {
      const feedObservations = await loadCurrentObservationsForClaims(articleId, "FEED_TEXT");
      await persistClaimsForArticle(prisma, {
        articleId,
        text: sanitizedFeedText,
        extractionSource: "FEED_TEXT",
        observations: feedObservations,
      });
    }
  } catch (err) {
    console.error(`[ingest] claim extraction failed for article ${articleId}:`, err);
  }
}

async function linkKeywords(articleId: string, title: string): Promise<void> {
  const phrases = extractKeywordPhrases(title);
  for (const term of phrases) {
    try {
      const keyword = await prisma.keyword.upsert({
        where: { term },
        create: { term },
        update: {},
      });
      await prisma.articleKeyword.upsert({
        where: { articleId_keywordId: { articleId, keywordId: keyword.id } },
        create: { articleId, keywordId: keyword.id, weight: 1 },
        update: {},
      });
    } catch (err) {
      console.error(`[ingest] failed to link keyword "${term}":`, err);
    }
  }
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "P2002");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for direct integration testing with synthetic FeedItem[] input,
// bypassing the real network fetch entirely (see test/provenanceIngestion.integration.test.ts).
export { FeedFetchError, persistItems };
