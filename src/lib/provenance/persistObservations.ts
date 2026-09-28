import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { extractObservations } from "./extract";
import { buildAliasIndex, type AliasIndex, type AliasRecord } from "./entityResolution";
import {
  isPersistableConfidence,
  type ProvenanceExtractionSource,
} from "@/lib/validation/provenance";

/**
 * Bumped whenever extraction logic changes meaningfully (a new pattern,
 * a false-positive fix, a changed confidence-tier rule). Reprocessing
 * compares against this to decide which stored observations are stale
 * (see clearStaleObservations below). No ExtractionRun model in Phase
 * 7B — a plain version string is sufficient (see ARCHITECTURE.md).
 */
export const EXTRACTOR_VERSION = "attribution-regex@1";

const MAX_EVIDENCE_TEXT_LENGTH = 200;

/**
 * Loads the full (small) alias table once per worker tick / backfill
 * batch, for the caller to reuse across every article — never query the
 * database once per regex match (see ARCHITECTURE.md's Phase 7
 * performance notes).
 */
export async function loadAliasIndex(prisma: PrismaClient): Promise<AliasIndex> {
  const rows = await prisma.provenanceAlias.findMany({ include: { entity: true } });
  const records: AliasRecord[] = rows.map((row) => ({
    entityId: row.entityId,
    entityType: row.entity.entityType as AliasRecord["entityType"],
    canonicalName: row.entity.canonicalName,
    aliasText: row.aliasText,
    normalizedAlias: row.normalizedAlias,
    matchType: row.matchType as AliasRecord["matchType"],
  }));
  return buildAliasIndex(records);
}

function computeDedupeKey(parts: {
  articleId: string;
  extractorVersion: string;
  extractionSource: string;
  startOffset: number;
  endOffset: number;
  relationshipType: string;
  rawEntityText: string;
}): string {
  const key = [
    parts.articleId,
    parts.extractorVersion,
    parts.extractionSource,
    parts.startOffset,
    parts.endOffset,
    parts.relationshipType,
    parts.rawEntityText,
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

export interface PersistObservationsResult {
  persisted: number;
  /** Confidence LOW is never written — Phase 7B's locked precision policy. Counted for observability/tests only. */
  discardedLow: number;
}

/**
 * Extracts and persists observations for one article's text. Confidence
 * LOW is filtered out before any database write — Phase 7B's locked
 * product decision (false negative over false positive; see
 * ARCHITECTURE.md). Every failure is isolated per-observation: the caller
 * (src/lib/ingest/ingestSource.ts) must never let anything here prevent
 * the Article row itself from being created, the same way
 * ingestSource.ts's own linkKeywords() already isolates keyword-linking
 * failures.
 */
export async function persistObservationsForArticle(
  prisma: PrismaClient,
  params: {
    articleId: string;
    text: string;
    extractionSource: ProvenanceExtractionSource;
    publisherName: string | undefined;
    aliasIndex: AliasIndex;
    extractorVersion?: string;
  },
): Promise<PersistObservationsResult> {
  const extractorVersion = params.extractorVersion ?? EXTRACTOR_VERSION;
  const extracted = extractObservations(params.text, params.aliasIndex, params.publisherName, {
    maxEvidenceLength: MAX_EVIDENCE_TEXT_LENGTH,
  });

  let persisted = 0;
  let discardedLow = 0;

  for (const observation of extracted) {
    if (!isPersistableConfidence(observation.confidence)) {
      discardedLow += 1;
      continue;
    }

    const dedupeKey = computeDedupeKey({
      articleId: params.articleId,
      extractorVersion,
      extractionSource: params.extractionSource,
      startOffset: observation.startOffset,
      endOffset: observation.endOffset,
      relationshipType: observation.relationshipType,
      rawEntityText: observation.rawEntityText,
    });

    try {
      // dedupeKey already encodes every field that would otherwise change,
      // so a rerun's "update" branch is a deliberate no-op — this makes
      // repeated worker/backfill runs safe without duplicating rows, the
      // same unique-constraint-based idempotency pattern Article.urlHash
      // already establishes (src/lib/ingest/ingestSource.ts).
      await prisma.provenanceObservation.upsert({
        where: { dedupeKey },
        create: {
          articleId: params.articleId,
          entityId: observation.resolvedEntity?.entityId ?? null,
          rawEntityText: observation.rawEntityText,
          relationshipType: observation.relationshipType,
          evidenceType: observation.evidenceType,
          confidence: observation.confidence,
          evidenceText: observation.evidenceText,
          extractionSource: params.extractionSource,
          startOffset: observation.startOffset,
          endOffset: observation.endOffset,
          extractorVersion,
          dedupeKey,
        },
        update: {},
      });
      persisted += 1;
    } catch (err) {
      console.error(
        `[provenance] failed to persist observation for article ${params.articleId}:`,
        err,
      );
    }
  }

  return { persisted, discardedLow };
}

/**
 * Removes stale extractor-generated observations for an article before
 * reprocessing it — any row at a DIFFERENT extractorVersion than the one
 * about to be (re)written. Never deletes a row whose reviewState is
 * ADMIN_OVERRIDE, regardless of its version — a manually-corrected
 * observation must survive every future reprocessing run. Safe to call
 * unconditionally before persistObservationsForArticle on every backfill
 * pass; a no-op for an article with no stale rows.
 */
export async function clearStaleObservations(
  prisma: PrismaClient,
  articleId: string,
  currentExtractorVersion: string = EXTRACTOR_VERSION,
): Promise<number> {
  const result = await prisma.provenanceObservation.deleteMany({
    where: {
      articleId,
      extractorVersion: { not: currentExtractorVersion },
      reviewState: { not: "ADMIN_OVERRIDE" },
    },
  });
  return result.count;
}
