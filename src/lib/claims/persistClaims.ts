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

  await prisma.$transaction(async (tx) => {
    const existingRows = await tx.claim.findMany({
      where: {
        articleId: params.articleId,
        claimExtractorVersion,
        reviewState: { not: "ADMIN_OVERRIDE" },
      },
      select: { dedupeKey: true },
    });
    const existingKeys = new Set(existingRows.map((row) => row.dedupeKey));
    let budget = Math.max(0, MAX_CLAIMS_PER_ARTICLE - existingRows.length);

    for (const claim of prioritized) {
      const alreadyPersisted = existingKeys.has(claim.dedupeKey);
      if (!alreadyPersisted) {
        if (budget <= 0) {
          cappedByLimit += 1;
          continue;
        }
        budget -= 1;
      }

      try {
        await tx.claim.upsert({
          where: { dedupeKey: claim.dedupeKey },
          create: {
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
          },
          update: {},
        });
        persisted += 1;
      } catch (err) {
        console.error(`[claims] failed to persist claim for article ${params.articleId}:`, err);
      }
    }
  });

  return { persisted, cappedByLimit, discardedLow };
}

/**
 * Removes stale extractor-generated claims for an article before
 * reprocessing it — any row at a DIFFERENT claimExtractorVersion than the
 * one about to be (re)written. Never deletes an ADMIN_OVERRIDE row,
 * regardless of its version. Mirrors clearStaleObservations exactly.
 */
export async function clearStaleClaims(
  prisma: PrismaClient,
  articleId: string,
  currentClaimExtractorVersion: string = CLAIM_EXTRACTOR_VERSION,
): Promise<number> {
  const result = await prisma.claim.deleteMany({
    where: {
      articleId,
      claimExtractorVersion: { not: currentClaimExtractorVersion },
      reviewState: { not: "ADMIN_OVERRIDE" },
    },
  });
  return result.count;
}
