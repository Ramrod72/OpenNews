import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  extractNumericalAssertions,
  type ExtractedNumericalClaim,
} from "./extractNumericalAssertions";
import {
  buildAttributedStatementClaims,
  type AttributedStatementSourceObservation,
  type ExtractedAttributedStatement,
} from "./buildAttributedStatementClaims";
import { normalizeClaimText } from "./normalize";
import {
  isPersistableConfidence,
  type ProvenanceExtractionSource,
} from "@/lib/validation/provenance";
import { withWriteQueue } from "@/lib/writeQueue";

/**
 * Bumped whenever claim-extraction logic changes meaningfully (a new unit
 * rule, a qualifier fix, a negation-detection change). Reprocessing
 * compares against this to decide which stored claims are stale (see
 * clearStaleClaims below) — the exact same versioning discipline
 * EXTRACTOR_VERSION already establishes for Phase 7 observations.
 */
export const CLAIM_EXTRACTOR_VERSION = "claim-regex@1";

const MAX_CLAIM_TEXT_LENGTH = 200;

/**
 * Phase 10B defensive cap: a hard maximum of auto-generated (non-
 * ADMIN_OVERRIDE) Claim rows persisted per (articleId, claimExtractorVersion),
 * enforced here regardless of how many separate calls this function
 * receives for the same article (TITLE, then FEED_TEXT for new ingestion;
 * TITLE, then STORED_EXCERPT_BACKFILL for historical backfill) — the exact
 * same defensive shape MAX_OBSERVATIONS_PER_ARTICLE already establishes,
 * closing the same "hostile/repetitive feed text inflates this table
 * unboundedly" risk for claims.
 */
export const MAX_CLAIMS_PER_ARTICLE = 20;

const CONFIDENCE_PRIORITY: Record<string, number> = { HIGH: 0, MEDIUM: 1 };

/** Stable sort moving HIGH ahead of MEDIUM without disturbing relative order within either tier — mirrors persistObservations.ts's prioritizeByConfidence exactly. */
function prioritizeByConfidence<T extends { confidence: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (CONFIDENCE_PRIORITY[a.confidence] ?? 1) - (CONFIDENCE_PRIORITY[b.confidence] ?? 1),
  );
}

function computeDedupeKey(parts: {
  articleId: string;
  claimExtractorVersion: string;
  extractionSource: string;
  kind: string;
  startOffset: number;
  endOffset: number;
  entityId: string | null;
  numericUnit: string | null;
  numericQualifier: string | null;
}): string {
  const key = [
    parts.articleId,
    parts.claimExtractorVersion,
    parts.extractionSource,
    parts.kind,
    parts.startOffset,
    parts.endOffset,
    parts.entityId ?? "",
    parts.numericUnit ?? "",
    parts.numericQualifier ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

interface PreparedClaim {
  kind: "NUMERICAL_ASSERTION" | "ATTRIBUTED_STATEMENT";
  rawText: string;
  normalizedText: string;
  entityId: string | null;
  numericValue: number | null;
  numericUnit: string | null;
  numericQualifier: string | null;
  startOffset: number;
  endOffset: number;
  confidence: "HIGH" | "MEDIUM";
  dedupeKey: string;
}

function prepareClaim(
  claim: ExtractedNumericalClaim | ExtractedAttributedStatement,
  articleId: string,
  claimExtractorVersion: string,
  extractionSource: string,
): PreparedClaim {
  const entityId = claim.kind === "ATTRIBUTED_STATEMENT" ? claim.entityId : null;
  const numericValue = claim.kind === "NUMERICAL_ASSERTION" ? claim.numericValue : null;
  const numericUnit = claim.kind === "NUMERICAL_ASSERTION" ? claim.unit : null;
  const numericQualifier = claim.kind === "NUMERICAL_ASSERTION" ? claim.qualifier : null;

  return {
    kind: claim.kind,
    rawText: claim.rawText,
    normalizedText: normalizeClaimText(claim.rawText),
    entityId,
    numericValue,
    numericUnit,
    numericQualifier,
    startOffset: claim.startOffset,
    endOffset: claim.endOffset,
    confidence: claim.confidence,
    dedupeKey: computeDedupeKey({
      articleId,
      claimExtractorVersion,
      extractionSource,
      kind: claim.kind,
      startOffset: claim.startOffset,
      endOffset: claim.endOffset,
      entityId,
      numericUnit,
      numericQualifier,
    }),
  };
}

export interface PersistClaimsResult {
  persisted: number;
  /** Candidates that were otherwise persistable but were dropped solely by MAX_CLAIMS_PER_ARTICLE. Observability/tests only. */
  cappedByLimit: number;
  /**
   * Candidates discarded solely for carrying a non-persistable confidence
   * value (i.e. not HIGH/MEDIUM). extractNumericalAssertions never
   * produces this, but an ATTRIBUTED_STATEMENT claim's confidence is
   * copied through from a caller-supplied Phase 7 observation (a plain
   * string column, not a database-enforced enum) — this is an independent
   * defense-in-depth guard at the point of persistence, the same one
   * persistObservations.ts's own isPersistableConfidence check already
   * establishes, rather than trusting that every caller only ever supplies
   * an already-filtered observation. Observability/tests only.
   */
  discardedLow: number;
}

/**
 * Extracts and persists both claim kinds for one article's text, for ONE
 * extractionSource at a time (TITLE, then FEED_TEXT for new ingestion;
 * TITLE, then STORED_EXCERPT_BACKFILL for historical backfill — see
 * src/lib/ingest/ingestSource.ts / worker/backfill-claims.ts). `params.observations`
 * must be the CURRENT-extractorVersion Phase 7 ProvenanceObservation rows
 * already persisted for this exact (articleId, extractionSource) pair —
 * this function never re-derives attribution itself (see
 * buildAttributedStatementClaims.ts's doc comment).
 *
 * Enforces MAX_CLAIMS_PER_ARTICLE across the whole article, not just this
 * one call's candidates, the same way persistObservationsForArticle
 * enforces MAX_OBSERVATIONS_PER_ARTICLE — and with the identical
 * concurrency-safety shape: the budget check and the writes that consume
 * it run inside one prisma.$transaction, so two concurrent calls for the
 * SAME (articleId, claimExtractorVersion) cannot both read a stale
 * pre-write count and collectively overshoot the cap (see
 * persistObservations.ts's own doc comment for the full argument — this
 * mirrors it exactly, precisely to avoid repeating Phase 8's own
 * previously-fixed observation-cap concurrency race).
 *
 * The transaction is additionally wrapped in `withWriteQueue` (see
 * src/lib/writeQueue.ts and persistObservations.ts's identical wrapping —
 * this mirrors it exactly), serializing it against every other write-
 * containing operation in this worker process so it never has to wait
 * behind sibling writers for the SQLite write lock under real concurrent
 * ingestion. This function is a "queue-acquiring leaf": it must never be
 * called from inside another queue-acquiring function, and must never
 * call one itself.
 */
export async function persistClaimsForArticle(
  prisma: PrismaClient,
  params: {
    articleId: string;
    text: string;
    extractionSource: ProvenanceExtractionSource;
    observations: readonly AttributedStatementSourceObservation[];
    claimExtractorVersion?: string;
  },
): Promise<PersistClaimsResult> {
  const claimExtractorVersion = params.claimExtractorVersion ?? CLAIM_EXTRACTOR_VERSION;

  const numerical = extractNumericalAssertions(params.text, {
    maxRawTextLength: MAX_CLAIM_TEXT_LENGTH,
  });
  const attributed = buildAttributedStatementClaims(params.text, params.observations, {
    maxRawTextLength: MAX_CLAIM_TEXT_LENGTH,
  });

  // Defense-in-depth: extractNumericalAssertions never produces anything
  // but HIGH/MEDIUM, but an ATTRIBUTED_STATEMENT's confidence is copied
  // through from a caller-supplied Phase 7 observation — a plain string
  // column, not a database-enforced enum. Never trust that upstream
  // filtering alone keeps LOW out; independently discard anything that
  // isn't persistable right here, the same guard persistObservations.ts
  // already applies at its own point of persistence.
  const candidates = [...numerical, ...attributed];
  let discardedLow = 0;
  const persistable = candidates.filter((c) => {
    if (isPersistableConfidence(c.confidence)) return true;
    discardedLow += 1;
    return false;
  });

  const prepared: PreparedClaim[] = persistable.map((c) =>
    prepareClaim(c, params.articleId, claimExtractorVersion, params.extractionSource),
  );

  // HIGH prioritized over MEDIUM, stable otherwise — applied before the
  // cap so a HIGH-confidence candidate is never dropped in favor of a
  // MEDIUM one.
  const prioritized = prioritizeByConfidence(prepared);

  let persisted = 0;
  let cappedByLimit = 0;

  await withWriteQueue(() =>
    prisma.$transaction(async (tx) => {
      // Selects EVERY existing row for this (articleId, claimExtractorVersion)
      // — including ADMIN_OVERRIDE ones — unlike the budget count just below,
      // which still excludes them. This is deliberate: the old per-row
      // `upsert()` silently no-op'd (via its `update: {}` branch) if a fresh
      // candidate's dedupeKey ever happened to collide with an
      // already-existing row regardless of that row's reviewState, including
      // an ADMIN_OVERRIDE one. A plain `createMany` has no such find-or-create
      // fallback — attempting to INSERT a dedupeKey that already belongs to an
      // ADMIN_OVERRIDE row would throw a unique-constraint violation for the
      // *entire* batch instead of silently skipping just that one candidate.
      // Treating every existing dedupeKey (override or not) as "already
      // persisted, do not write" preserves the old no-throw behavior and
      // never touches an ADMIN_OVERRIDE row's content — see
      // test/claimPersistence.integration.test.ts's "ADMIN_OVERRIDE dedupeKey
      // collision" case.
      const existingRows = await tx.claim.findMany({
        where: { articleId: params.articleId, claimExtractorVersion },
        select: { dedupeKey: true, reviewState: true },
      });
      const existingKeys = new Set(existingRows.map((row) => row.dedupeKey));
      const nonOverrideCount = existingRows.filter(
        (row) => row.reviewState !== "ADMIN_OVERRIDE",
      ).length;
      let budget = Math.max(0, MAX_CLAIMS_PER_ARTICLE - nonOverrideCount);

      // Single pass: decide which candidates are genuinely new (not already
      // durably persisted, not a repeat of an earlier candidate in THIS same
      // batch) and within budget, without issuing any database write yet.
      // Already-persisted/already-queued candidates are counted toward
      // `persisted` here (matching the old per-row upsert's behavior, where a
      // no-op re-upsert of an existing row still counted as "persisted") but
      // never produce a write — this is what collapses the up-to-
      // MAX_CLAIMS_PER_ARTICLE sequential round trips down to at most one.
      const seenInBatch = new Set<string>();
      const rowsToCreate: Array<{
        articleId: string;
        kind: PreparedClaim["kind"];
        rawText: string;
        normalizedText: string;
        entityId: string | null;
        numericValue: number | null;
        numericUnit: string | null;
        numericQualifier: string | null;
        extractionSource: string;
        startOffset: number;
        endOffset: number;
        confidence: PreparedClaim["confidence"];
        claimExtractorVersion: string;
        dedupeKey: string;
      }> = [];

      for (const claim of prioritized) {
        if (existingKeys.has(claim.dedupeKey) || seenInBatch.has(claim.dedupeKey)) {
          persisted += 1;
          continue;
        }
        if (budget <= 0) {
          cappedByLimit += 1;
          continue;
        }
        budget -= 1;
        seenInBatch.add(claim.dedupeKey);
        rowsToCreate.push({
          articleId: params.articleId,
          kind: claim.kind,
          rawText: claim.rawText,
          normalizedText: claim.normalizedText,
          entityId: claim.entityId,
          numericValue: claim.numericValue,
          numericUnit: claim.numericUnit,
          numericQualifier: claim.numericQualifier,
          extractionSource: params.extractionSource,
          startOffset: claim.startOffset,
          endOffset: claim.endOffset,
          confidence: claim.confidence,
          claimExtractorVersion,
          dedupeKey: claim.dedupeKey,
        });
      }

      // One round trip for the whole batch instead of up to
      // MAX_CLAIMS_PER_ARTICLE sequential ones — this is what keeps this
      // interactive transaction short enough to stay well under Prisma's
      // default 5000ms transaction timeout even under concurrent SQLite
      // writer contention from other articles being ingested at the same
      // time (see ARCHITECTURE.md's SQLite concurrency note). `skipDuplicates`
      // is intentionally NOT used here — empirically confirmed unsupported by
      // Prisma 6.19.3's SQLite connector (rejected at both the TypeScript and
      // runtime level) — every row in `rowsToCreate` is already guaranteed
      // collision-free by the filtering above, so a plain `createMany` is
      // both correct and the smallest viable fix.
      if (rowsToCreate.length > 0) {
        try {
          const result = await tx.claim.createMany({ data: rowsToCreate });
          persisted += result.count;
        } catch (err) {
          console.error(
            `[claims] failed to persist a batch of ${rowsToCreate.length} claim(s) for article ${params.articleId} (extractionSource=${params.extractionSource}):`,
            err,
          );
        }
      }
    }),
  );

  return { persisted, cappedByLimit, discardedLow };
}

/**
 * Removes stale extractor-generated claims for an article before
 * reprocessing it — any row at a DIFFERENT claimExtractorVersion than the
 * one about to be (re)written. Never deletes an ADMIN_OVERRIDE row,
 * regardless of its version. Mirrors clearStaleObservations exactly.
 *
 * Only called from worker/backfill-claims.ts, which runs its own
 * CONCURRENCY=4 mapWithConcurrency over articles — the exact same
 * in-process write-lock contention shape as live ingestion. This
 * deleteMany is itself a write statement, so it is wrapped in
 * src/lib/writeQueue.ts's queue, making it a queue-acquiring leaf (a
 * sibling of persistClaimsForArticle, never nested inside it — the
 * backfill script calls this leaf, then separately calls
 * persistClaimsForArticle, each acquiring and releasing the queue in
 * turn). Must never be called from inside another queue-acquiring
 * function, and must never call one itself.
 */
export async function clearStaleClaims(
  prisma: PrismaClient,
  articleId: string,
  currentClaimExtractorVersion: string = CLAIM_EXTRACTOR_VERSION,
): Promise<number> {
  return withWriteQueue(async () => {
    const result = await prisma.claim.deleteMany({
      where: {
        articleId,
        claimExtractorVersion: { not: currentClaimExtractorVersion },
        reviewState: { not: "ADMIN_OVERRIDE" },
      },
    });
    return result.count;
  });
}
