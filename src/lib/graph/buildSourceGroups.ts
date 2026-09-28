import type {
  PersistableConfidence,
  ProvenanceEntityType,
  ProvenanceEvidenceType,
  ProvenanceRelationshipType,
} from "@/lib/validation/provenance";
import { findNearDuplicatePairs, type ExcerptCandidate } from "./excerptSimilarity";
import type {
  ObservationRef,
  OriginalReportingSignal,
  PrimaryEvidenceGroup,
  SharedReportingSourceGroup,
} from "./types";

/**
 * Pure reasoning over already-loaded, in-memory cluster data — no Prisma,
 * no I/O, no network access. getClusterOriginSummary.ts is responsible for
 * loading this shape efficiently; everything here is a plain function of
 * its arguments, which makes it directly unit-testable without a database.
 */

export interface ArticleForGrouping {
  id: string;
  sourceId: string;
  sourceName: string;
  excerpt: string | null;
}

export interface ObservationForGrouping {
  id: string;
  articleId: string;
  entityId: string | null;
  rawEntityText: string;
  relationshipType: ProvenanceRelationshipType;
  evidenceType: ProvenanceEvidenceType;
  confidence: PersistableConfidence;
  evidenceText: string;
}

export interface EntityForGrouping {
  id: string;
  canonicalName: string;
  entityType: ProvenanceEntityType;
  mergedIntoId: string | null;
}

/**
 * Primary-evidence evidence types that would, IF Phase 7B's extractor ever
 * captured a distinguishing document identifier, be candidates for a
 * genuinely strong "same document" grouping. Currently none of the
 * extractor's fixed-phrase rules for these types resolve an entity (see
 * patterns.ts's FIXED_PHRASE_RULES — entityId is always null for them), so
 * buildPrimaryEvidenceGroups below correctly and honestly never produces a
 * group today; this list exists so that if a future extractor enhancement
 * (explicitly out of scope for Phase 8B) adds resolvable identifiers, this
 * module doesn't need another architecture change.
 */
const PRIMARY_EVIDENCE_TYPES: ReadonlySet<ProvenanceEvidenceType> = new Set([
  "COURT_FILING",
  "GOVERNMENT_DOCUMENT",
  "STUDY_OR_DATASET",
  "PRESS_RELEASE",
]);

/** Bounds mergedIntoId chain-walking so a pathological/cyclic chain can never loop forever. */
export const MAX_MERGE_CHAIN_DEPTH = 25;

/**
 * Dereferences ProvenanceEntity.mergedIntoId to find the entity id
 * observations should actually be grouped under. Handles, without ever
 * throwing or looping forever:
 *  - a plain chain (A -> B -> C): resolves to C.
 *  - a missing merge target (mergedIntoId points to an id not in
 *    `entitiesById` — shouldn't happen given the schema's onDelete: SetNull,
 *    but never trusted): stops and returns the last id that was still
 *    resolvable.
 *  - a cycle (A -> B -> A): detected via a visited-set check before
 *    following another edge; stops and returns the id at which the cycle
 *    was (re)detected. This means two different starting ids inside the
 *    same cycle can resolve to two different "canonical" ids rather than
 *    being merged together — a deliberate false-negative-over-false-
 *    positive choice: refusing to merge is safe, guessing which node in a
 *    broken cycle is "real" is not.
 *  - a pathologically long chain: MAX_MERGE_CHAIN_DEPTH bounds the walk;
 *    past it, resolution stops wherever it is and returns that id.
 * Never mutates any ProvenanceEntity row — read-only, in-memory only.
 */
export function resolveCanonicalEntityId(
  startEntityId: string,
  entitiesById: ReadonlyMap<string, EntityForGrouping>,
  maxDepth: number = MAX_MERGE_CHAIN_DEPTH,
): string {
  let current = startEntityId;
  const visited = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(current)) return current; // cycle detected — bounded, deterministic fallback
    visited.add(current);

    const entity = entitiesById.get(current);
    if (!entity || !entity.mergedIntoId) return current; // unknown entity, or not merged any further
    if (!entitiesById.has(entity.mergedIntoId)) return current; // merge target missing — stop here

    current = entity.mergedIntoId;
  }

  return current; // pathological depth — stop and use whatever was reached
}

function toObservationRef(canonicalEntityId: string | null) {
  return (obs: ObservationForGrouping): ObservationRef => ({
    observationId: obs.id,
    articleId: obs.articleId,
    entityId: canonicalEntityId,
    relationshipType: obs.relationshipType,
    evidenceType: obs.evidenceType,
    confidence: obs.confidence,
    rawEntityText: obs.rawEntityText,
    evidenceText: obs.evidenceText,
  });
}

function excerptCandidatesFor(
  articleIds: readonly string[],
  articlesById: ReadonlyMap<string, ArticleForGrouping>,
): ExcerptCandidate[] {
  return articleIds.map((id) => ({
    articleId: id,
    excerpt: articlesById.get(id)?.excerpt ?? "",
  }));
}

const NEAR_DUP_NOTE =
  "Excerpt word-shingle overlap only; may reflect shared or syndicated source text. Not proof of exact dispatch identity, and not a claim that the underlying facts are independently confirmed.";

/**
 * Groups observations by resolved ProvenanceEntity (after mergedIntoId
 * dereferencing) within this ONE cluster's data only. A group is only
 * produced when 2+ DISTINCT articles cite the same canonical entity —
 * "shared" requires sharing across articles, not just existing.
 *
 * Generic/role-based/anonymous observations (entityId === null — "police
 * said," "officials said," "people familiar with the matter," ...) are
 * NEVER included here, regardless of how similar their evidenceText or
 * rawEntityText looks across articles: matching wording for an
 * unresolved, non-specific role is not evidence of a shared reporting
 * source (see Phase 8B spec's generic-source rule).
 */
export function buildSharedReportingSourceGroups(input: {
  articles: ArticleForGrouping[];
  observations: ObservationForGrouping[];
  entities: EntityForGrouping[];
}): SharedReportingSourceGroup[] {
  const entitiesById = new Map(input.entities.map((e) => [e.id, e]));
  const articlesById = new Map(input.articles.map((a) => [a.id, a]));

  const byCanonicalEntity = new Map<string, ObservationForGrouping[]>();
  for (const obs of input.observations) {
    if (obs.entityId === null) continue;
    const canonicalId = resolveCanonicalEntityId(obs.entityId, entitiesById);
    const list = byCanonicalEntity.get(canonicalId) ?? [];
    list.push(obs);
    byCanonicalEntity.set(canonicalId, list);
  }

  const groups: SharedReportingSourceGroup[] = [];
  for (const [canonicalId, obsList] of byCanonicalEntity) {
    const articleIds = [...new Set(obsList.map((o) => o.articleId))].sort();
    if (articleIds.length < 2) continue; // one citing article isn't a "shared" group

    const entity = entitiesById.get(canonicalId);
    if (!entity) continue; // defensive: canonicalId always came from entitiesById, but never assume

    const nearDuplicateTextSignals = findNearDuplicatePairs(
      excerptCandidatesFor(articleIds, articlesById),
    ).map((pair) => ({
      label: "LIKELY_SHARED_TEXT_ORIGIN" as const,
      confidence: "STRONGLY_INFERRED" as const,
      articleIdA: pair.articleIdA,
      articleIdB: pair.articleIdB,
      similarity: pair.similarity,
      note: NEAR_DUP_NOTE,
    }));

    groups.push({
      groupType: "SHARED_REPORTING_SOURCE",
      entityId: canonicalId,
      entityCanonicalName: entity.canonicalName,
      entityType: entity.entityType,
      // POSSIBLE, never CONFIRMED: explicit same-entity citation across
      // articles, nothing about same dispatch or independent confirmation.
      confidence: "POSSIBLE",
      articleIds,
      observations: obsList
        .map(toObservationRef(canonicalId))
        .sort((a, b) => a.observationId.localeCompare(b.observationId)),
      nearDuplicateTextSignals,
    });
  }

  groups.sort(
    (a, b) =>
      a.entityCanonicalName.localeCompare(b.entityCanonicalName) ||
      a.entityId.localeCompare(b.entityId),
  );
  return groups;
}

/**
 * Groups primary-evidence observations (court filing, government
 * document, study/dataset, press release) that share BOTH the same
 * resolved canonical entity AND the same evidenceType — the minimum bar
 * for treating them as plausibly the same underlying document, and still
 * only ever POSSIBLE, never CONFIRMED. Given Phase 7B's current extractor
 * (see patterns.ts), none of these evidence types are ever produced
 * alongside a resolved entity, so this correctly returns [] today — see
 * PRIMARY_EVIDENCE_TYPES's comment. It deliberately does NOT group by
 * evidenceType alone: two unresolved "according to court records"
 * observations across different articles must never become a strong
 * shared-document group merely because both say "court records."
 */
export function buildPrimaryEvidenceGroups(input: {
  observations: ObservationForGrouping[];
  entities: EntityForGrouping[];
}): PrimaryEvidenceGroup[] {
  const entitiesById = new Map(input.entities.map((e) => [e.id, e]));

  const byCanonicalEntityAndType = new Map<string, ObservationForGrouping[]>();
  for (const obs of input.observations) {
    if (obs.entityId === null) continue;
    if (!PRIMARY_EVIDENCE_TYPES.has(obs.evidenceType)) continue;
    const canonicalId = resolveCanonicalEntityId(obs.entityId, entitiesById);
    const key = `${canonicalId}::${obs.evidenceType}`;
    const list = byCanonicalEntityAndType.get(key) ?? [];
    list.push(obs);
    byCanonicalEntityAndType.set(key, list);
  }

  const groups: PrimaryEvidenceGroup[] = [];
  for (const [key, obsList] of byCanonicalEntityAndType) {
    const articleIds = [...new Set(obsList.map((o) => o.articleId))].sort();
    if (articleIds.length < 2) continue;

    const [canonicalId, evidenceType] = key.split("::") as [string, ProvenanceEvidenceType];
    const entity = entitiesById.get(canonicalId);
    if (!entity) continue;

    groups.push({
      groupType: "PRIMARY_EVIDENCE",
      entityId: canonicalId,
      entityCanonicalName: entity.canonicalName,
      evidenceType,
      confidence: "POSSIBLE",
      articleIds,
      observations: obsList
        .map(toObservationRef(canonicalId))
        .sort((a, b) => a.observationId.localeCompare(b.observationId)),
    });
  }

  groups.sort(
    (a, b) =>
      a.entityCanonicalName.localeCompare(b.entityCanonicalName) ||
      a.evidenceType.localeCompare(b.evidenceType),
  );
  return groups;
}

/**
 * Every article's own ORIGINAL_REPORTING_CLAIM observation, surfaced
 * as-is — never aggregated across articles (originality is a property of
 * one article/publisher, not a cross-article relationship), never turned
 * into a whole-article truth claim or a publisher-quality score.
 */
export function buildOriginalReportingSignals(input: {
  articles: ArticleForGrouping[];
  observations: ObservationForGrouping[];
}): OriginalReportingSignal[] {
  const articlesById = new Map(input.articles.map((a) => [a.id, a]));

  const signals: OriginalReportingSignal[] = [];
  for (const obs of input.observations) {
    if (obs.relationshipType !== "ORIGINAL_REPORTING_CLAIM") continue;
    const article = articlesById.get(obs.articleId);
    if (!article) continue;
    signals.push({
      articleId: obs.articleId,
      publisherSourceId: article.sourceId,
      publisherName: article.sourceName,
      observationId: obs.id,
      confidence: obs.confidence,
      evidenceText: obs.evidenceText,
    });
  }

  signals.sort(
    (a, b) =>
      a.articleId.localeCompare(b.articleId) || a.observationId.localeCompare(b.observationId),
  );
  return signals;
}
