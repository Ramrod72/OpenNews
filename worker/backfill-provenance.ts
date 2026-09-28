import "dotenv/config";
import { prisma } from "@/lib/db";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  EXTRACTOR_VERSION,
  clearStaleObservations,
  loadAliasIndex,
  persistObservationsForArticle,
} from "@/lib/provenance/persistObservations";
import type { AliasIndex } from "@/lib/provenance/entityResolution";

/**
 * Explicitly-invoked historical backfill for provenance observations.
 * NOT run automatically by the migration and NOT wired into the worker's
 * cron tick — run manually with `npm run backfill:provenance` (optionally
 * `-- --after=<articleId>` to resume after an interrupted run, or
 * `-- --dry-run` to see counts without writing).
 *
 * Historical articles only ever have `title` and `excerpt` in the
 * database — the fuller sanitized feed text available at ingestion time
 * (see src/lib/ingest/ingestSource.ts) was never persisted and cannot be
 * recovered. This script therefore NEVER claims a FEED_TEXT observation:
 * only extractionSource "TITLE" and "STORED_EXCERPT_BACKFILL" are ever
 * produced here, honestly reflecting what evidence was actually
 * available. It never fetches a publisher's page, never refetches a feed,
 * and never follows an article's link — it operates entirely on text
 * already stored in this database.
 */

const BATCH_SIZE = 200;
const CONCURRENCY = 4;

interface BackfillTotals {
  persisted: number;
  discardedLow: number;
}

async function processArticle(
  article: { id: string; title: string; excerpt: string | null; source: { name: string } },
  aliasIndex: AliasIndex,
): Promise<BackfillTotals> {
  try {
    // Removes stale extractor-generated rows for this article (any prior
    // version, never an ADMIN_OVERRIDE row) before re-extracting, so a
    // version bump cleanly replaces old observations rather than
    // accumulating them alongside new ones.
    await clearStaleObservations(prisma, article.id, EXTRACTOR_VERSION);

    const titleResult = await persistObservationsForArticle(prisma, {
      articleId: article.id,
      text: article.title,
      extractionSource: "TITLE",
      publisherName: article.source.name,
      aliasIndex,
    });

    let excerptResult: BackfillTotals = { persisted: 0, discardedLow: 0 };
    if (article.excerpt) {
      excerptResult = await persistObservationsForArticle(prisma, {
        articleId: article.id,
        text: article.excerpt,
        extractionSource: "STORED_EXCERPT_BACKFILL",
        publisherName: article.source.name,
        aliasIndex,
      });
    }

    return {
      persisted: titleResult.persisted + excerptResult.persisted,
      discardedLow: titleResult.discardedLow + excerptResult.discardedLow,
    };
  } catch (err) {
    console.error(`[backfill] failed for article ${article.id}:`, err);
    return { persisted: 0, discardedLow: 0 };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const afterArg = args.find((a) => a.startsWith("--after="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");

  console.log(
    `[backfill] starting (extractorVersion=${EXTRACTOR_VERSION}, dryRun=${dryRun})` +
      (afterArg ? `, resuming after article ${afterArg}` : ""),
  );

  // Loaded once for the entire run, reused across every batch/article —
  // never queried once per article, let alone once per regex match (see
  // ARCHITECTURE.md's Phase 7 performance notes).
  const aliasIndex = await loadAliasIndex(prisma);

  let cursor: string | undefined = afterArg;
  let processed = 0;
  let persisted = 0;
  let discardedLow = 0;

  for (;;) {
    const batch = await prisma.article.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, title: true, excerpt: true, source: { select: { name: true } } },
    });
    if (batch.length === 0) break;

    if (!dryRun) {
      const results = await mapWithConcurrency(batch, CONCURRENCY, (article) =>
        processArticle(article, aliasIndex),
      );
      for (const r of results) {
        persisted += r.persisted;
        discardedLow += r.discardedLow;
      }
    }

    processed += batch.length;
    cursor = batch[batch.length - 1]!.id;
    console.log(
      `[backfill] processed ${processed} articles so far (resume point: --after=${cursor})` +
        (dryRun
          ? " [dry-run]"
          : `, ${persisted} observations persisted, ${discardedLow} LOW discarded`),
    );
  }

  console.log(
    `[backfill] done. ${processed} articles processed, ${persisted} observations persisted, ${discardedLow} LOW candidates discarded.`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
