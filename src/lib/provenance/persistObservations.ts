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
 * Phase 8B defensive cap: a hard maximum of auto-generated (non-
 * ADMIN_OVERRIDE) ProvenanceObservation rows persisted per (articleId,
 * extractorVersion), enforced here regardless of how many separate calls
 * this function receives for the same article (TITLE, then FEED_TEXT for
 * new ingestion; TITLE, then STORED_EXCERPT_BACKFILL for historical
 * backfill — see ingestSource.ts / backfill-provenance.ts). Without this,
 * a hostile or malformed feed item that repeats an attribution phrase
 * hundreds or thousands of times (e.g. "Reuters reported. Reuters
 * reported. ...") would pass every existing confidence/dedupe guard and
 * still write one row per repetition, unboundedly inflating this table
 * for a single article. The cap never touches ADMIN_OVERRIDE rows (a
 * manual correction survives forever, and never counts against this
 * budget) and is idempotent: rerunning extraction for the same text
 * re-upserts the same already-persisted rows (a no-op) rather than
 * consuming fresh budget, so a rerun never shrinks or reorders what was
 * already kept.
 */
export const MAX_OBSERVATIONS_PER_ARTICLE = 20;

const CONFIDENCE_PRIORITY: Record<string, number> = { HIGH: 0, MEDIUM: 1 };

/**
 * Stable sort (Array.prototype.sort is guaranteed stable) that moves HIGH
 * ahead of MEDIUM without disturbing relative textual/evidence order
 * within either tier — the array arrives already ordered by startOffset
 * (see extract.ts's suppressOverlaps), and that ordering is exactly what
 * "without destabilizing textual/evidence ordering" means here.
 */
function prioritizeByConfidence<T extends { confidence: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (CONFIDENCE_PRIORITY[a.confidence] ?? 1) - (CONFIDENCE_PRIORITY[b.confidence] ?? 1),
  );
}

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
  /**
   * Phase 8B: candidates that were otherwise persistable (HIGH/MEDIUM) but
   * were dropped solely by MAX_OBSERVATIONS_PER_ARTICLE. Counted for
   * observability/tests only — never affects control flow.
   */
  cappedByLimit: number;
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
 *
 * Phase 8B: also enforces MAX_OBSERVATIONS_PER_ARTICLE across the whole
 * article, not just this one call's candidates — a single article can
 * reach this function more than once (TITLE then FEED_TEXT at ingestion;
 * TITLE then STORED_EXCERPT_BACKFILL during backfill), and the cap must
 * hold regardless of how the text was split across those calls.
 *
 * Concurrency: the budget check (read existing count) and the writes that
 * consume it run inside one `prisma.$transaction`, so two concurrent calls
 * for the SAME (articleId, extractorVersion) — e.g. a live-ingestion call
 * racing a manually-triggered backfill touching the same article — cannot
 * both read a stale pre-write count and collectively overshoot the cap:
 * the database serializes the two transactions (SQLite has a single
 * writer; Postgres uses standard row/transaction isolation), so the
 * second transaction's read only commits after the first transaction's
 * writes are visible. Extraction itself (the pure, non-DB work above) is
 * NOT inside the transaction — only the count-and-write section is —
 * keeping the transaction's own work small.
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

  let discardedLow = 0;
  const persistable: (typeof extracted)[number][] = [];
  for (const observation of extracted) {
    if (!isPersistableConfidence(observation.confidence)) {
      discardedLow += 1;
      continue;
    }
    persistable.push(observation);
  }

  // HIGH prioritized over MEDIUM, stable otherwise (see
  // prioritizeByConfidence) — applied before the cap so that when a
  // candidate must be dropped, a HIGH-confidence one is never dropped in
  // favor of a MEDIUM one.
  const prioritized = prioritizeByConfidence(persistable).map((observation) => ({
    observation,
    dedupeKey: computeDedupeKey({
      articleId: params.articleId,
      extractorVersion,
      extractionSource: params.extractionSource,
      startOffset: observation.startOffset,
      endOffset: observation.endOffset,
      relationshipType: observation.relationshipType,
      rawEntityText: observation.rawEntityText,
    }),
  }));

  let persisted = 0;
  let cappedByLimit = 0;

  await prisma.$transaction(async (tx) => {
    // Selects EVERY existing row for this (articleId, extractorVersion) —
    // including ADMIN_OVERRIDE ones — unlike the budget count just below,
    // which still excludes them, exactly as before. This is deliberate: the
    // old per-row `upsert()` silently no-op'd (via its `update: {}` branch)
    // if a fresh candidate's dedupeKey ever happened to collide with an
    // already-existing row regardless of that row's reviewState, including
    // an ADMIN_OVERRIDE one. A plain `createMany` has no such find-or-create
    // fallback — attempting to INSERT a dedupeKey that already belongs to an
    // ADMIN_OVERRIDE row would throw a unique-constraint violation for the
    // *entire* batch instead of silently skipping just that one candidate.
    // Treating every existing dedupeKey (override or not) as "already
    // persisted, do not write" preserves the old no-throw behavior and
    // never touches an ADMIN_OVERRIDE row's content. Reading this INSIDE
    // the transaction (rather than before it) is still what closes the
    // concurrent-call race described above.
    const existingRows = await tx.provenanceObservation.findMany({
      where: { articleId: params.articleId, extractorVersion },
      select: { dedupeKey: true, reviewState: true },
    });
    const existingKeys = new Set(existingRows.map((row) => row.dedupeKey));
    const nonOverrideCount = existingRows.filter(
      (row) => row.reviewState !== "ADMIN_OVERRIDE",
    ).length;
    let budget = Math.max(0, MAX_OBSERVATIONS_PER_ARTICLE - nonOverrideCount);

    // Single pass: decide which candidates are genuinely new (not already
    // durably persisted, not a repeat of an earlier candidate in THIS same
    // batch) and within budget, without issuing any database write yet.
    // Already-persisted/already-queued candidates are counted toward
    // `persisted` here (matching the old per-row upsert's behavior, where a
    // no-op re-upsert of an existing row still counted as "persisted") but
    // never produce a write — this is what collapses the up-to-
    // MAX_OBSERVATIONS_PER_ARTICLE sequential round trips down to at most
    // one, the same change applied to src/lib/claims/persistClaims.ts.
    const seenInBatch = new Set<string>();
    const rowsToCreate: Array<{
      articleId: string;
      entityId: string | null;
      rawEntityText: string;
      relationshipType: string;
      evidenceType: string;
      confidence: string;
      evidenceText: string;
      extractionSource: string;
      startOffset: number;
      endOffset: number;
      extractorVersion: string;
      dedupeKey: string;
    }> = [];

    for (const { observation, dedupeKey } of prioritized) {
      if (existingKeys.has(dedupeKey) || seenInBatch.has(dedupeKey)) {
        persisted += 1;
        continue;
      }
      if (budget <= 0) {
        cappedByLimit += 1;
        continue;
      }
      budget -= 1;
      seenInBatch.add(dedupeKey);
      rowsToCreate.push({
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
      });
    }

    // One round trip for the whole batch instead of up to
    // MAX_OBSERVATIONS_PER_ARTICLE sequential ones — see
    // src/lib/claims/persistClaims.ts's identical change for the full
    // reasoning (SQLite single-writer contention under concurrent
    // ingestion). `skipDuplicates` is intentionally NOT used — empirically
    // confirmed unsupported by Prisma 6.19.3's SQLite connector — every row
    // in `rowsToCreate` is already guaranteed collision-free by the
    // filtering above.
    if (rowsToCreate.length > 0) {
      try {
        const result = await tx.provenanceObservation.createMany({ data: rowsToCreate });
        persisted += result.count;
      } catch (err) {
        console.error(
          `[provenance] failed to persist a batch of ${rowsToCreate.length} observation(s) for article ${params.articleId} (extractionSource=${params.extractionSource}):`,
          err,
        );
      }
    }
  });

  return { persisted, discardedLow, cappedByLimit };
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
