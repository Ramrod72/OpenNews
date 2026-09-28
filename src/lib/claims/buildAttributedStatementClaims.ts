import { findContainingSentence, splitSentences } from "./sentenceBoundary";

const DEFAULT_MAX_RAW_TEXT_LENGTH = 200;

/**
 * The minimal shape this module needs from an already-persisted Phase 7
 * ProvenanceObservation row. Callers (see ingestSource.ts /
 * worker/backfill-claims.ts) query current-extractorVersion observations
 * for the SAME (articleId, extractionSource) pair immediately after Phase
 * 7 persists them, then pass those rows straight in here — this module
 * never re-derives attribution itself (see this file's own top-level doc
 * comment and AGENTS-facing Phase 10B spec §5, "Single Attribution
 * Authority": ATTRIBUTED_STATEMENT must have a defensible relationship to
 * an actual persisted Phase 7 observation, never a second, independently
 * re-implemented attribution detector).
 */
export interface AttributedStatementSourceObservation {
  entityId: string | null;
  startOffset: number;
  endOffset: number;
  confidence: "HIGH" | "MEDIUM";
}

export interface ExtractedAttributedStatement {
  kind: "ATTRIBUTED_STATEMENT";
  entityId: string | null;
  rawText: string;
  startOffset: number;
  endOffset: number;
  confidence: "HIGH" | "MEDIUM";
}

function boundText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLength).trimEnd()}…`;
}

/**
 * Builds ATTRIBUTED_STATEMENT claim candidates by locating the sentence
 * containing each Phase 7 observation's span within `text` (the SAME text
 * buffer the observations were extracted from — TITLE or FEED_TEXT/
 * STORED_EXCERPT_BACKFILL). The claim's assertion is "a statement was
 * attributed to this entity" (or, when entityId is null, to an
 * unresolved/generic role) — NEVER a claim that the statement's content is
 * true. `entityId` is carried through unresolved (null) rather than
 * discarded: an unresolved attribution is still a real, defensible
 * attribution signal (see Phase 7B's own "generic/role-based sourcing"
 * precedent), just not attributable to a specific checkable organization.
 *
 * Multiple observations that resolve to the SAME entity within the SAME
 * sentence collapse to one claim (deduplicated by entityId + sentence
 * span) — they describe the same attributed statement, not distinct ones.
 * Observations in different sentences, or with different entities in the
 * same sentence, each produce their own claim.
 */
export function buildAttributedStatementClaims(
  text: string,
  observations: readonly AttributedStatementSourceObservation[],
  options?: { maxRawTextLength?: number },
): ExtractedAttributedStatement[] {
  if (!text || !text.trim() || observations.length === 0) return [];

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const maxRawTextLength = options?.maxRawTextLength ?? DEFAULT_MAX_RAW_TEXT_LENGTH;
  const byKey = new Map<string, ExtractedAttributedStatement>();

  for (const obs of observations) {
    const sentence = findContainingSentence(sentences, obs.startOffset, obs.endOffset);
    if (!sentence) continue; // observation span not inside any detected sentence — skip rather than guess

    const key = `${obs.entityId ?? ""}::${sentence.startOffset}::${sentence.endOffset}`;
    if (byKey.has(key)) continue; // same entity, same sentence — already have this claim

    byKey.set(key, {
      kind: "ATTRIBUTED_STATEMENT",
      entityId: obs.entityId,
      rawText: boundText(sentence.text, maxRawTextLength),
      startOffset: sentence.startOffset,
      endOffset: sentence.endOffset,
      confidence: obs.confidence,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => a.startOffset - b.startOffset);
}
