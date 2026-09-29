import "dotenv/config";
import { prisma } from "@/lib/db";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  CLAIM_EXTRACTOR_VERSION,
  clearStaleClaims,
  persistClaimsForArticle,
} from "@/lib/claims/persistClaims";
import { EXTRACTOR_VERSION } from "@/lib/provenance/persistObservations";
import type { AttributedStatementSourceObservation } from "@/lib/claims/buildAttributedStatementClaims";

/**
 * Explicitly-invoked historical backfill for Phase 10B claims. NOT run
 * automatically by the migration and NOT wired into the worker's cron
 * tick — run manually with `npm run backfill:claims` (optionally
 * `-- --after=<articleId>` to resume after an interrupted run, or
 * `-- --dry-run` to see counts without writing). Modeled directly on
 * worker/backfill-provenance.ts.
 *
 * Historical articles only ever have `title` and `excerpt` in the
 * database — the fuller sanitized feed text available at ingestion time
 * was never persisted and cannot be recovered. This script therefore
 * NEVER claims a FEED_TEXT extractionSource: only "TITLE" and
 * "STORED_EXCERPT_BACKFILL" are ever produced here, honestly reflecting
 * what evidence was actually available.
 *
 * ATTRIBUTED_STATEMENT claims are derived from this article's ALREADY-
 * PERSISTED current-extractorVersion Phase 7 ProvenanceObservation rows
 * (see buildAttributedStatementClaims.ts) — this script never re-detects
 * attribution itself, and produces zero ATTRIBUTED_STATEMENT claims for
 * an article that has no such observations yet. Running
 * `npm run backfill:provenance` first (so Phase 7 observations exist) is
 * an operational prerequisite for full ATTRIBUTED_STATEMENT coverage, not
 * a hard requirement — NUMERICAL_ASSERTION extraction is fully
 * independent of it and always runs regardless.
 *
 * Never fetches a publisher's page, never refetches a feed, and never
 * follows an article's link — it operates entirely on text already stored
 * in this database.
 */

const BATCH_SIZE = 200;
const CONCURRENCY = 4;

interface BackfillTotals {
  persisted: number;
  cappedByLimit: number;
}

async function loadCurrentObservations(
  articleId: string,
  extractionSource: "TITLE" | "STORED_EXCERPT_BACKFILL",
): Promise<AttributedStatementSourceObservation[]> {
  const rows = await prisma.provenanceObservation.findMany({
    where: {
      articleId,
      extractionSource,
      // Same filter shape getClusterOriginSummary.ts and
      // ingestSource.ts's loadCurrentObservationsForClaims already use —
      // only the current EXTRACTOR_VERSION's rows (backfill-provenance.ts
      // writes with this same constant), plus any ADMIN_OVERRIDE row
      // regardless of its version tag.
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

async function processArticle(article: {
  id: string;
  title: string;
  excerpt: string | null;
}): Promise<BackfillTotals> {
  try {
    await clearStaleClaims(prisma, article.id, CLAIM_EXTRACTOR_VERSION);

    const titleObservations = await loadCurrentObservations(article.id, "TITLE");
    const titleResult = await persistClaimsForArticle(prisma, {
      articleId: article.id,
      text: article.title,
      extractionSource: "TITLE",
      observations: titleObservations,
    });

    let excerptResult: BackfillTotals = { persisted: 0, cappedByLimit: 0 };
    if (article.excerpt) {
      const excerptObservations = await loadCurrentObservations(
        article.id,
        "STORED_EXCERPT_BACKFILL",
      );
      excerptResult = await persistClaimsForArticle(prisma, {
        articleId: article.id,
        text: article.excerpt,
        extractionSource: "STORED_EXCERPT_BACKFILL",
        observations: excerptObservations,
      });
    }

    return {
      persisted: titleResult.persisted + excerptResult.persisted,
      cappedByLimit: titleResult.cappedByLimit + excerptResult.cappedByLimit,
    };
  } catch (err) {
    console.error(`[backfill-claims] failed for article ${article.id}:`, err);
    return { persisted: 0, cappedByLimit: 0 };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const afterArg = args.find((a) => a.startsWith("--after="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");

  console.log(
    `[backfill-claims] starting (claimExtractorVersion=${CLAIM_EXTRACTOR_VERSION}, dryRun=${dryRun})` +
      (afterArg ? `, resuming after article ${afterArg}` : ""),
  );

  let cursor: string | undefined = afterArg;
  let processed = 0;
  let persisted = 0;
  let cappedByLimit = 0;

  for (;;) {
    const batch = await prisma.article.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, title: true, excerpt: true },
    });
    if (batch.length === 0) break;

    if (!dryRun) {
      const results = await mapWithConcurrency(batch, CONCURRENCY, (article) =>
        processArticle(article),
      );
      for (const r of results) {
        persisted += r.persisted;
        cappedByLimit += r.cappedByLimit;
      }
    }

    processed += batch.length;
    cursor = batch[batch.length - 1]!.id;
    console.log(
      `[backfill-claims] processed ${processed} articles so far (resume point: --after=${cursor})` +
        (dryRun
          ? " [dry-run]"
          : `, ${persisted} claims persisted, ${cappedByLimit} capped by limit`),
    );
  }

  console.log(
    `[backfill-claims] done. ${processed} articles processed, ${persisted} claims persisted, ${cappedByLimit} candidates capped by limit.`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-claims] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
