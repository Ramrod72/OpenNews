import { findAllCandidates, type AttributionCandidate } from "./patterns";
import { resolveEntity, type AliasIndex, type ResolvedEntity } from "./entityResolution";
import type {
  ProvenanceConfidence,
  ProvenanceEvidenceType,
  ProvenanceRelationshipType,
} from "@/lib/validation/provenance";

const DEFAULT_MAX_EVIDENCE_LENGTH = 200;

export interface ExtractedObservation {
  relationshipType: ProvenanceRelationshipType;
  evidenceType: ProvenanceEvidenceType;
  /** May be LOW — persistObservations() is responsible for filtering it out before any DB write. */
  confidence: ProvenanceConfidence;
  rawEntityText: string;
  resolvedEntity: ResolvedEntity | null;
  /** Bounded-length snippet of the actual matched clause — never the full input text. */
  evidenceText: string;
  startOffset: number;
  endOffset: number;
}

type ResolvedCandidate = AttributionCandidate & { resolvedEntity: ResolvedEntity | null };

const LEADING_ARTICLE_RE = /^(the|an?)\s+/i;

/**
 * Resolves a captured entity phrase, retrying once with a leading English
 * article stripped if the first attempt fails. This exists because a
 * sentence-initial capitalized "The" gets swallowed into the entity
 * capture purely due to capitalization (e.g. "The FBI said..." captures
 * "The FBI", not "FBI") even though "The" is not actually part of the
 * entity's name — unlike a case like "The Associated Press", which is
 * seeded as its own alias and resolves directly, so this fallback never
 * fires for it. rawEntityText is never mutated by this — only the lookup
 * key is retried.
 */
function resolveEntityWithArticleFallback(
  rawText: string,
  index: AliasIndex,
): ResolvedEntity | null {
  const direct = resolveEntity(rawText, index);
  if (direct) return direct;
  const stripped = rawText.replace(LEADING_ARTICLE_RE, "");
  if (stripped === rawText) return null;
  return resolveEntity(stripped, index);
}

/**
 * Pure orchestration: run every pattern matcher, resolve/discard
 * entity-dependent candidates, finalize relationship/evidence/confidence
 * for resolved entities, suppress overlapping matches, and slice bounded
 * evidence snippets. No DB access, no I/O — the caller supplies a
 * pre-built AliasIndex (see entityResolution.ts) and, for the newly-
 * ingested case, the current article's own publisher name (used only to
 * confirm ORIGINAL_REPORTING_CLAIM — see patterns.ts).
 */
export function extractObservations(
  text: string,
  aliasIndex: AliasIndex,
  publisherName: string | undefined,
  options?: { maxEvidenceLength?: number },
): ExtractedObservation[] {
  if (!text || !text.trim()) return [];

  const candidates = findAllCandidates(text, publisherName);

  const resolved: ResolvedCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.requiresEntityResolution) {
      const entity = resolveEntityWithArticleFallback(candidate.rawEntityText, aliasIndex);
      if (!entity) continue; // unresolved named-entity candidate: discard entirely (precision-first)
      resolved.push({ ...candidate, resolvedEntity: entity });
    } else if (candidate.attemptEntityResolution) {
      // Kept regardless of resolution — the grammatical construction
      // itself (e.g. "in an interview with <Entity>") is the precision
      // guard here, not alias membership. Resolution only enriches the
      // relationship when it succeeds (see finalizeCandidate).
      const entity = resolveEntityWithArticleFallback(candidate.rawEntityText, aliasIndex);
      resolved.push({ ...candidate, resolvedEntity: entity });
    } else {
      resolved.push({ ...candidate, resolvedEntity: null });
    }
  }

  const finalized = resolved.map(finalizeCandidate);
  const accepted = suppressOverlaps(finalized);

  const maxEvidenceLength = options?.maxEvidenceLength ?? DEFAULT_MAX_EVIDENCE_LENGTH;
  return accepted.map((c) => {
    const rawSnippet = text.slice(c.startOffset, c.endOffset);
    const evidenceText =
      rawSnippet.length > maxEvidenceLength
        ? `${rawSnippet.slice(0, maxEvidenceLength - 1).trimEnd()}…`
        : rawSnippet;
    return {
      relationshipType: c.relationshipType,
      evidenceType: c.evidenceType,
      confidence: c.confidence,
      rawEntityText: c.rawEntityText,
      resolvedEntity: c.resolvedEntity,
      evidenceText,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
    };
  });
}

/**
 * A resolved short (<=4 char) EXACT-match alias ("AP", "DOJ", "FBI") is
 * capped at MEDIUM even in an otherwise-HIGH construction — these tokens
 * remain inherently more ambiguous than a full name even immediately
 * after a real attribution verb (see §5/§10 of the Phase 7A design: "be
 * especially careful with ambiguous short aliases such as AP"). Full names
 * resolved via CASE_INSENSITIVE match ("Reuters", "Associated Press",
 * "Department of Justice", "Federal Bureau of Investigation") keep HIGH.
 */
function finalizeCandidate(candidate: ResolvedCandidate): ResolvedCandidate {
  const entity = candidate.resolvedEntity;
  if (!entity) return candidate; // fixed-phrase / self-referential candidates are already final

  const isShortExactAlias = entity.matchType === "EXACT" && entity.aliasText.trim().length <= 4;
  const confidence: ProvenanceConfidence = isShortExactAlias ? "MEDIUM" : "HIGH";

  let relationshipType: ProvenanceRelationshipType;
  let evidenceType: ProvenanceEvidenceType;

  switch (entity.entityType) {
    case "WIRE_SERVICE":
      relationshipType = "CITES_WIRE_SERVICE";
      evidenceType = "REPORTING_CITATION";
      break;
    case "NEWS_OUTLET":
      relationshipType = "CITES_OTHER_OUTLET";
      evidenceType = "REPORTING_CITATION";
      break;
    case "GOVERNMENT_AGENCY":
      relationshipType = "CITES_STATEMENT";
      evidenceType = "STATEMENT";
      break;
    default:
      relationshipType = "CITES_STATEMENT";
      evidenceType = candidate.evidenceType === "UNKNOWN" ? "STATEMENT" : candidate.evidenceType;
  }

  return { ...candidate, relationshipType, evidenceType, confidence };
}

/**
 * Keeps the longer/more-specific match when two candidates' spans overlap
 * (e.g. "sources familiar with the matter said" fully contains — and
 * should suppress — a redundant bare "sources said" match over the same
 * clause). Sorts by start offset, then by span length descending, and
 * drops any candidate fully contained within an already-accepted span.
 */
function suppressOverlaps(candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    return b.endOffset - b.startOffset - (a.endOffset - a.startOffset);
  });

  const accepted: ResolvedCandidate[] = [];
  for (const candidate of sorted) {
    const containedInAccepted = accepted.some(
      (a) => candidate.startOffset >= a.startOffset && candidate.endOffset <= a.endOffset,
    );
    if (!containedInAccepted) accepted.push(candidate);
  }
  return accepted;
}
