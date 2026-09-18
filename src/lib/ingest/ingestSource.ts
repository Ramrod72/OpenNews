import type { Source } from "@prisma/client";
import { prisma } from "@/lib/db";
import { excerpt, safeImageUrl, toPlainText } from "@/lib/security/sanitize";
import { extractImageUrl, fetchAndParseFeed, FeedFetchError, type FeedItem } from "./fetchFeed";
import { hashUrl, normalizeTitle, normalizeUrl } from "./normalize";
import { extractKeywordPhrases } from "@/lib/nlp/keywords";

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
    const publishedAt = parseDate(item.isoDate || item.pubDate) ?? new Date();

    try {
      const created = await prisma.article.create({
        data: {
          sourceId: source.id,
          url: normalized,
          urlHash,
          title,
          titleNormalized: normalizeTitle(title),
          excerpt: rawExcerpt ? excerpt(rawExcerpt) : null,
          imageUrl: safeImageUrl(extractImageUrl(item)),
          author: item.creator ? toPlainText(item.creator, 200) : null,
          categoryId: category?.id,
          publishedAt,
          guid: item.guid ?? item.link,
        },
      });
      await linkKeywords(created.id, title);
      itemsNew += 1;
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

export { FeedFetchError };
