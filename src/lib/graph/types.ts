import type {
  PersistableConfidence,
  ProvenanceEntityType,
  ProvenanceEvidenceType,
  ProvenanceRelationshipType,
} from "@/lib/validation/provenance";

/**
 * Phase 8B — Source-group / origin-reasoning foundation.
 *
 * Everything in src/lib/graph/ is QUERY-TIME DERIVED reasoning over
 * Phase 7B's already-persisted ProvenanceObservation/Entity/Alias rows and
 * StoryCluster's already-computed clustering. Nothing here is persisted:
 * no new table, no migration, no InformationOriginGroup / OriginGroupMember
 * / SourceGraphEdge / GraphEdge / ReportingRelationship row ever exists.
 * Every function in this namespace recomputes its answer from scratch each
 * call — cheap because a single StoryCluster's article/observation count is
 * always small relative to the whole database (see getClusterOriginSummary
 * for the bounded query shape this relies on).
 *
 * Scope is always exactly one StoryCluster. A cluster grouping articles
 * together is itself only a topical-similarity signal (see
 * src/lib/clustering/cluster.ts) — it is NOT evidence that the articles in
 * it share an origin, and nothing here treats it as such. All reasoning
 * below stays strictly INSIDE one cluster; nothing ever compares articles
 * across two different clusters.
 *
 * Epistemic rules that constrain every type and function in this
 * namespace (see ARCHITECTURE.md's Phase 8B section for the full
 * rationale):
 *  - Prefer UNKNOWN over an unsupported inference.
 *  - Prefer a false negative over a false positive.
 *  - Similarity is never identity.
 *  - Shared attribution is never confirmation.
 *  - Publisher diversity is never provenance diversity.
 *  - Primary evidence is never automatically true.
 *  - Absence of detected provenance is never evidence of original reporting.
 *
 * Nothing here computes, exposes, or implies a single "independent origin
 * count," a reliability/truth/corroboration score, or claim-level
 * corroboration ("X and Y confirm the same fact"). Multiple separate,
 * traceable, factual metrics are exposed instead — see ClusterOriginSummary.
 */

/**
 * How confident a CROSS-ARTICLE relationship (not a single observation's
 * own directness) is, given only what Phase 7B currently captures:
 *
 * - EXPLICIT: what a single ProvenanceObservation itself already states —
 *   "this article's text cites this entity, this way." Not an inference.
 * - POSSIBLE: two or more articles in this cluster explicitly cite the SAME
 *   resolved ProvenanceEntity. This means "these articles cite the same
 *   reporting source" — nothing more. It is explicitly NOT "same dispatch,"
 *   NOT "independently confirmed," and NOT "same underlying claim."
 * - STRONGLY_INFERRED: only when additional deterministic evidence
 *   materially strengthens a shared-text/shared-origin relationship beyond
 *   POSSIBLE — currently, only the near-duplicate-excerpt signal (see
 *   excerptSimilarity.ts) reaches this tier, and even then it is exposed as
 *   corroborating-only, never as proof of exact dispatch identity.
 * - UNKNOWN: there is not enough distinguishing information to say
 *   anything about a relationship between articles/evidence.
 *
 * CONFIRMED is deliberately NOT a member of this union. Confirming that two
 * articles share the literal same origin (the same dispatch, the same
 * document) would require an identifier Phase 7B's extractor does not
 * capture (no docket/document IDs, no wire-service dispatch IDs). Given
 * current data, this module may legitimately never produce anything above
 * STRONGLY_INFERRED — that is an accepted, intentional limitation, not a
 * bug, and adding a CONFIRMED tier without the evidence to justify it would
 * be exactly the kind of overclaiming this phase must avoid.
 */
export const SOURCE_GROUP_CONFIDENCE_VALUES = [
  "EXPLICIT",
  "POSSIBLE",
  "STRONGLY_INFERRED",
  "UNKNOWN",
] as const;
export type SourceGroupConfidence = (typeof SOURCE_GROUP_CONFIDENCE_VALUES)[number];

/**
 * One piece of underlying evidence a grouping traces back to. Every group
 * below carries an array of these — a grouping must never "collapse away"
 * the observations that justify it.
 */
export interface ObservationRef {
  observationId: string;
  articleId: string;
  /** Resolved entity id AFTER mergedIntoId dereferencing (see buildSourceGroups.ts), or null if unresolved. */
  entityId: string | null;
  relationshipType: ProvenanceRelationshipType;
  evidenceType: ProvenanceEvidenceType;
  confidence: PersistableConfidence;
  rawEntityText: string;
  evidenceText: string;
}

/**
 * Conservative, corroborating-only near-duplicate-excerpt signal (see
 * excerptSimilarity.ts). Deliberately NOT named/labeled anything implying
 * proven identity ("SAME_REUTERS_DISPATCH", "CONFIRMED_SAME_ORIGIN") — two
 * articles' stored excerpts overlapping heavily MAY reflect shared or
 * syndicated source text, but word-shingle overlap over a 220-character
 * excerpt can never prove exact dispatch identity on its own.
 */
export interface NearDuplicateTextSignal {
  label: "LIKELY_SHARED_TEXT_ORIGIN";
  confidence: "STRONGLY_INFERRED";
  articleIdA: string;
  articleIdB: string;
  /** Jaccard similarity of normalized word shingles, in [0, 1]. */
  similarity: number;
  note: string;
}

/**
 * Observations from two or more articles in this cluster that explicitly
 * cite the SAME resolved ProvenanceEntity (after mergedIntoId
 * dereferencing). Named SHARED_REPORTING_SOURCE deliberately, not "shared
 * origin" or "same dispatch": this means "these articles cite the same
 * reporting entity," nothing about whether the underlying reporting acts
 * were the same act, and nothing about whether the cited facts are true.
 * See the Reuters/AP note on getClusterOriginSummary.ts for the locked
 * product-language rule this enforces.
 */
export interface SharedReportingSourceGroup {
  groupType: "SHARED_REPORTING_SOURCE";
  entityId: string;
  entityCanonicalName: string;
  /**
   * Distinguishes two different kinds of "shared" citation, neither
   * stronger than the other: WIRE_SERVICE/NEWS_OUTLET means the articles
   * cite a reporting intermediary (Reuters, AP, another outlet).
   * GOVERNMENT_AGENCY/COURT/LAW_ENFORCEMENT/COMPANY/RESEARCH_INSTITUTION/
   * INDIVIDUAL means the articles instead cite the same PRIMARY SOURCE/
   * newsmaker directly (e.g. two articles both quoting the same DOJ
   * statement) — routine and, if anything, an even weaker signal, since
   * many outlets independently attending the same press conference is
   * completely unremarkable. A consumer must not treat every group here
   * as a reporting-intermediary relationship without checking this field.
   */
  entityType: ProvenanceEntityType;
  /** POSSIBLE for the base same-entity relationship; never CONFIRMED. */
  confidence: SourceGroupConfidence;
  articleIds: string[];
  observations: ObservationRef[];
  /**
   * Near-duplicate-excerpt signals found between specific article pairs
   * INSIDE this entity group only (never compared cluster-wide — see
   * excerptSimilarity.ts). May be empty; presence never changes this
   * group's own `confidence` field — it is exposed as its own separate,
   * traceable, corroborating-only signal instead of being folded into one
   * score (see the "multiple metrics, not one score" rule).
   */
  nearDuplicateTextSignals: NearDuplicateTextSignal[];
}

/**
 * A grouping of primary-evidence observations (COURT_FILING,
 * GOVERNMENT_DOCUMENT, STUDY_OR_DATASET, PRESS_RELEASE, ...) that share
 * enough genuinely distinguishing evidence to treat as citing the same
 * underlying document/dataset — NOT merely the same evidenceType label.
 * Phase 7B's extractor captures no document/docket/study identifiers, so
 * two generic "court filing" (or "press release", or "study") observations
 * across different articles currently never provide that distinguishing
 * evidence, and this module correctly produces no strong group for them
 * (see buildSourceGroups.ts) rather than grouping by evidenceType alone.
 * This type exists so a future extractor enhancement (out of scope for
 * Phase 8B) that DOES capture such identifiers has somewhere to land
 * without a further architecture change.
 */
export interface PrimaryEvidenceGroup {
  groupType: "PRIMARY_EVIDENCE";
  entityId: string;
  entityCanonicalName: string;
  evidenceType: ProvenanceEvidenceType;
  confidence: SourceGroupConfidence;
  articleIds: string[];
  observations: ObservationRef[];
}

/**
 * One article's own ORIGINAL_REPORTING_CLAIM observation, surfaced as-is.
 * Never aggregated into a cross-article group (originality is a property
 * of one article/publisher's own text, not a relationship between
 * articles), never turned into a whole-article truth claim or a
 * publisher-quality score.
 */
export interface OriginalReportingSignal {
  articleId: string;
  publisherSourceId: string;
  publisherName: string;
  observationId: string;
  confidence: PersistableConfidence;
  evidenceText: string;
}

/**
 * The internal DTO produced by getClusterOriginSummary(clusterId). Every
 * number here is one separate, factual, traceable metric — deliberately
 * NOT combined into independentOriginCount / originScore /
 * reliabilityScore / truthScore / corroborationScore, all of which imply a
 * confidence this data can't support. See ARCHITECTURE.md's Phase 8B
 * section for the full rationale.
 */
export interface ClusterOriginSummary {
  clusterId: string;
  articleCount: number;
  /** Count of distinct Source rows among this cluster's articles — publisher diversity, never provenance diversity. */
  publisherCount: number;

  sharedReportingSourceGroups: SharedReportingSourceGroup[];
  primaryEvidenceGroups: PrimaryEvidenceGroup[];
  originalReportingSignals: OriginalReportingSignal[];

  /** Articles in this cluster with zero persisted ProvenanceObservation rows — never silently omitted. */
  unresolvedArticleCount: number;
  provenanceCoverage: {
    articlesWithDetectedProvenance: number;
    articlesWithoutDetectedProvenance: number;
  };
}
