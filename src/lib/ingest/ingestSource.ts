import type { Prisma, Source } from "@prisma/client";
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
import { withWriteQueue } from "@/lib/writeQueue";

const RETRY_DELAYS_MS = [1000, 3000];

// Short, few retries for the trailing status write only — this is a tiny
// 2-row transaction (Source.update + FeedFetchLog.create), not a network
// fetch, so any contention it hits is purely transient SQLite write-lock
// queueing from other concurrently-fetching sources (CONCURRENT_FETCHES),
// not something a multi-second backoff is warranted for.
const STATUS_WRITE_RETRY_DELAYS_MS = [250, 750];

// Same short-delay shape as STATUS_WRITE_RETRY_DELAYS_MS, for the same
// reason: this is a single-row insert, not a network call, so any
// contention it hits is transient write-lock queueing, not something a
// multi-second backoff is warranted for.
const ARTICLE_CREATE_RETRY_DELAYS_MS = [250, 750];

// A real-world RSS/Atom feed almost always contains a bounded number of
// recent items (commonly a few dozen, rarely more than a couple hundred
// even for very active publishers). This cap exists purely to bound the
// WORST case: a malicious or compromised feed origin packing
// thousands/millions of minimal <item> entries into one response (still
// well under fetchFeed.ts's own 5MB size cap, since a bare title+link pair
// is only ~100-150 bytes) would otherwise force one full round of DB
// writes plus provenance/claim extraction PER item, with no bound at all.
// 500 is comfortably above any legitimate feed size seen in practice
// while still bounding a single ingestion run to a fixed, predictable
// amount of work.
export const MAX_ITEMS_PER_FETCH = 500;

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
    let result: { itemsFound: number; itemsNew: number };
    try {
      const feed = await fetchAndParseFeed(source.url);
      result = await persistItems(source, feed.items ?? []);
    } catch (err) {
      // A genuine fetch/parse/persistence failure — retry the whole
      // attempt (network + items), exactly as before.
      lastError = err instanceof Error ? err.message : "Unknown error";
      const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
      if (!isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }

    // Fetch + persistence already succeeded — every article, provenance
    // observation, and claim from this run is already durably committed.
    // A failure recording THIS small status transaction (Source.update +
    // FeedFetchLog.create) must never be treated as an ingestion failure:
    // doing so previously discarded the real itemsFound/itemsNew counts,
    // forced a wasted full re-fetch on retry, and could even let an
    // exhausted-retries write failure propagate uncaught out of this
    // function — which, via mapWithConcurrency's un-caught Promise.all,
    // failed the ENTIRE worker tick for every other concurrently-fetching
    // source too, not just this one — the production P1008 this fixes.
    await recordSuccessStatus(source.id, startedAt, result);
    return { sourceId: source.id, success: true, ...result };
  }

  await recordFailureStatus(source.id, startedAt, lastError);
  return { sourceId: source.id, success: false, itemsFound: 0, itemsNew: 0, error: lastError };
}

/**
 * Records a successful ingestion run's status. Retried a few times on its
 * own (short delays — this is a 2-row transaction, not a network call) to
 * absorb transient SQLite write-lock contention from other
 * concurrently-fetching sources; if it still never lands, the failure is
 * logged and swallowed rather than thrown — the caller's `result` (and the
 * `success: true` already returned to it) must never be retracted or
 * masked by an operational-metadata write failure, and this failure must
 * never propagate out and fail the whole tick for unrelated sources.
 *
 * Acquires src/lib/writeQueue.ts's queue ONCE for this whole call,
 * including every retry attempt — retries happen within that single held
 * turn rather than releasing and re-acquiring the queue between attempts,
 * so this operation's own internal retry delays can never be interleaved
 * with another queued write starting partway through. This function is a
 * queue-acquiring leaf: it must never be called from inside another
 * queue-acquiring function, and must never call one itself.
 */
async function recordSuccessStatus(
  sourceId: string,
  startedAt: Date,
  result: { itemsFound: number; itemsNew: number },
): Promise<void> {
  await withWriteQueue(async () => {
    for (let attempt = 0; attempt <= STATUS_WRITE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await prisma.$transaction([
          prisma.source.update({
            where: { id: sourceId },
            data: {
              lastFetchedAt: new Date(),
              lastSuccessAt: new Date(),
              lastError: null,
              consecutiveFailures: 0,
            },
          }),
          prisma.feedFetchLog.create({
            data: {
              sourceId,
              startedAt,
              finishedAt: new Date(),
              success: true,
              itemsFound: result.itemsFound,
              itemsNew: result.itemsNew,
            },
          }),
        ]);
        return;
      } catch (err) {
        const isLastAttempt = attempt === STATUS_WRITE_RETRY_DELAYS_MS.length;
        if (!isLastAttempt) {
          await sleep(STATUS_WRITE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        console.error(
          `[ingest] source ${sourceId} ingested successfully (${result.itemsNew} new / ` +
            `${result.itemsFound} found) but failed to record its success status after ` +
            `${STATUS_WRITE_RETRY_DELAYS_MS.length + 1} attempts:`,
          err,
        );
      }
    }
  });
}

/**
 * Records a failed ingestion run's status, after every fetch/persist retry
 * is exhausted. Never thrown out of this function: a failure writing the
 * failure record itself must not propagate uncaught and fail the whole
 * worker tick for unrelated, concurrently-fetching sources (the same
 * isolation guarantee recordSuccessStatus's doc comment describes).
 *
 * Also a queue-acquiring leaf — see recordSuccessStatus's doc comment for
 * the identical reasoning (this one has no retry loop of its own, but is
 * still wrapped for consistency and because a future retry could be
 * added here without needing to revisit queue placement).
 */
async function recordFailureStatus(
  sourceId: string,
  startedAt: Date,
  lastError: string | undefined,
): Promise<void> {
  await withWriteQueue(async () => {
    try {
      await prisma.$transaction([
        prisma.source.update({
          where: { id: sourceId },
          data: {
            lastFetchedAt: new Date(),
            lastErrorAt: new Date(),
            lastError,
            consecutiveFailures: { increment: 1 },
          },
        }),
        prisma.feedFetchLog.create({
          data: {
            sourceId,
            startedAt,
            finishedAt: new Date(),
            success: false,
            itemsFound: 0,
            itemsNew: 0,
            errorMessage: lastError,
          },
        }),
      ]);
    } catch (err) {
      console.error(
        `[ingest] source ${sourceId} failed, and failed to record its failure status:`,
        err,
      );
    }
  });
}

/**
 * Creates one Article row, retrying a bounded number of times on a
 * transient "database didn't respond in time" error (`P1008`/`P2024` —
 * the production P1008 this fixes). Never retries `P2002` (unique
 * constraint) or any other error — see isRetryableTransientError's own
 * doc comment for exactly why these two codes and no others.
 *
 * Each attempt acquires src/lib/writeQueue.ts's queue separately (unlike
 * recordSuccessStatus/recordFailureStatus, which hold one turn across all
 * their retries): releasing the queue during this function's own sleep
 * delay lets other queued sources' writes proceed instead of waiting out
 * this one's backoff, and nothing about this function's own correctness
 * depends on holding the queue between attempts. This function is a
 * queue-acquiring leaf: it must never be called from inside another
 * queue-acquiring function, and must never call one itself.
 *
 * Idempotency / lost-acknowledgment handling: if an EARLIER attempt in
 * this same call already saw a P1008/P2024 (meaning Prisma never
 * confirmed whether that attempt's INSERT actually committed) and a
 * SUBSEQUENT attempt then hits P2002 on the same urlHash, that row is
 * almost certainly the one OUR OWN earlier attempt actually created —
 * the acknowledgment was lost, not the write. Rather than retry again
 * (which would just hit the same constraint again) or silently drop the
 * item (losing its keywords/provenance/claims forever, since a future
 * tick's dedupe-by-urlHash check would see it as already existing and
 * never reprocess it), this fetches and returns the existing row instead
 * — a plain read, never queued, since reads don't need write-exclusivity
 * — so the caller's downstream processing still runs for it. A P2002 on
 * the very FIRST attempt (no prior timeout) is NOT this case — it's the
 * ordinary, already-expected "another source raced us to the same
 * syndicated URL" scenario, and is left for persistItems' own existing
 * isUniqueConstraintError skip to handle exactly as before.
 */
async function createArticleWithRetry(
  data: Prisma.ArticleUncheckedCreateInput,
): Promise<{ id: string } & Record<string, unknown>> {
  let sawTransientFailure = false;

  for (let attempt = 0; attempt <= ARTICLE_CREATE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await withWriteQueue(() => prisma.article.create({ data }));
    } catch (err) {
      if (sawTransientFailure && isUniqueConstraintError(err)) {
        return await prisma.article.findUniqueOrThrow({ where: { urlHash: data.urlHash } });
      }
      if (!isRetryableTransientError(err)) throw err;
      sawTransientFailure = true;
      const isLastAttempt = attempt === ARTICLE_CREATE_RETRY_DELAYS_MS.length;
      if (isLastAttempt) throw err;
      await sleep(ARTICLE_CREATE_RETRY_DELAYS_MS[attempt]);
    }
  }
  // Unreachable — the loop above always returns or throws.
  throw new Error("unreachable: createArticleWithRetry loop exited without returning or throwing");
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

  const totalItems = items.length;
  const boundedItems =
    totalItems > MAX_ITEMS_PER_FETCH ? items.slice(0, MAX_ITEMS_PER_FETCH) : items;
  if (totalItems > MAX_ITEMS_PER_FETCH) {
    // Deliberately logs only counts, never any item content — a hostile
    // feed's actual bulk content must never reach a log file.
    console.warn(
      `[ingest] ${source.name}: feed contained ${totalItems} items, processing only the ` +
        `first ${MAX_ITEMS_PER_FETCH}`,
    );
  }

  let itemsNew = 0;
  let itemsFound = 0;

  for (const item of boundedItems) {
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
      const created = await createArticleWithRetry({
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

/**
 * Links an article to every keyword phrase extracted from its title.
 * Batched rather than one upsert-pair per phrase (the same pre-filter/
 * batch pattern persistClaims.ts/persistObservations.ts already
 * established): a findMany to see which Keyword rows already exist, one
 * createMany for the genuinely-new ones, then the same shape for
 * ArticleKeyword links — collapsing what was up to 2 sequential round
 * trips PER PHRASE (an 8-phrase title could cost 16) down to at most 4
 * total round trips regardless of phrase count. This is the same class of
 * write-amplification PR #19 fixed for claim/observation persistence,
 * just one level up (this is a per-article, not per-call, hot path).
 *
 * `Keyword.term` is `@unique` and extraction can legitimately produce the
 * SAME phrase (e.g. "The White House") from different articles/sources
 * ingesting concurrently (CONCURRENT_FETCHES) — a genuine race, not just
 * defensive paranoia — so a createMany unique-constraint collision here is
 * expected and handled by re-reading rather than treated as a hard error,
 * exactly like persistItems' own article-urlHash race tolerance below.
 *
 * The entire write-containing body below (every findMany/createMany round
 * trip) runs inside one src/lib/writeQueue.ts acquisition — this function
 * is a queue-acquiring leaf: it must never be called from inside another
 * queue-acquiring function, and must never call one itself. Kept as the
 * existing batched round trips (never reintroducing a sequential
 * per-keyword write loop) — the queue only changes when this already-small
 * fixed-size batch of writes is allowed to run, not its shape.
 */
async function linkKeywords(articleId: string, title: string): Promise<void> {
  // Defensive dedupe: extractKeywordPhrases already returns distinct
  // phrases, but never trust a single upstream filter alone (the same
  // principle persistClaims.ts/persistObservations.ts apply to their own
  // candidate batches).
  const phrases = Array.from(new Set(extractKeywordPhrases(title)));
  if (phrases.length === 0) return;

  try {
    await withWriteQueue(async () => {
      const existingKeywords = await prisma.keyword.findMany({
        where: { term: { in: phrases } },
        select: { id: true, term: true },
      });
      const keywordIdByTerm = new Map(existingKeywords.map((k) => [k.term, k.id]));

      const newTerms = phrases.filter((term) => !keywordIdByTerm.has(term));
      if (newTerms.length > 0) {
        try {
          await prisma.keyword.createMany({ data: newTerms.map((term) => ({ term })) });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
        }
        // Re-fetch rather than assume createMany's rows map 1:1 to
        // newTerms — a concurrent ingest from another source may have
        // already inserted one of these exact terms between the findMany
        // above and this createMany (and, on a collision, NOTHING in
        // newTerms was written at all — createMany is all-or-nothing per
        // batch — so every genuinely-new term among them still needs this
        // re-fetch to pick up its real id).
        const refetched = await prisma.keyword.findMany({
          where: { term: { in: newTerms } },
          select: { id: true, term: true },
        });
        for (const k of refetched) keywordIdByTerm.set(k.term, k.id);
      }

      const keywordIds = phrases
        .map((term) => keywordIdByTerm.get(term))
        .filter((id): id is string => Boolean(id));
      if (keywordIds.length === 0) return;

      const existingLinks = await prisma.articleKeyword.findMany({
        where: { articleId, keywordId: { in: keywordIds } },
        select: { keywordId: true },
      });
      const alreadyLinked = new Set(existingLinks.map((l) => l.keywordId));
      const newLinks = keywordIds.filter((id) => !alreadyLinked.has(id));

      if (newLinks.length > 0) {
        try {
          await prisma.articleKeyword.createMany({
            data: newLinks.map((keywordId) => ({ articleId, keywordId, weight: 1 })),
          });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
        }
      }
    });
  } catch (err) {
    console.error(`[ingest] failed to link keywords for article ${articleId}:`, err);
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

// P1008 ("Socket timeout" / operation timed out) and P2024 ("Timed out
// fetching a new connection from the pool") are both purely about *how long
// this attempt had to wait for SQLite's single writer*, never about the
// data itself — exactly the transient contention src/lib/writeQueue.ts
// exists to eliminate going forward, and safe to retry because the
// operation never started executing (both are pre-execution timeouts).
// Deliberately NOT included: P2002 (unique constraint — a real, permanent
// outcome, not a timeout, and retrying it would never succeed) and any
// other/unknown error (could reflect a genuine data or logic problem that
// retrying would only mask).
function isRetryableTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return err.code === "P1008" || err.code === "P2024";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for direct integration testing with synthetic FeedItem[] input,
// bypassing the real network fetch entirely (see test/provenanceIngestion.integration.test.ts).
export { FeedFetchError, persistItems };

// Exported for direct integration testing of the batched keyword-linking
// path without needing a full article-creation round trip for every case
// (see test/linkKeywordsBatching.integration.test.ts).
export { linkKeywords };
