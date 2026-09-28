/**
 * Closed sets of allowed values for the provenance-extraction models
 * (ProvenanceEntity/ProvenanceAlias/ProvenanceObservation) — plain strings
 * validated here at the application layer, not Prisma enums, matching this
 * schema's established Postgres/SQLite-portability convention (see
 * Subscription.status, and src/lib/validation/sourceProfile.ts's
 * SOURCE_TYPE_VALUES/ASSESSMENT_TYPE_VALUES for the direct precedent).
 * Extending any list here is a one-line change, not a migration.
 */

/** What kind of thing a ProvenanceEntity is. */
export const PROVENANCE_ENTITY_TYPE_VALUES = [
  "WIRE_SERVICE",
  "GOVERNMENT_AGENCY",
  "COURT",
  "LAW_ENFORCEMENT",
  "COMPANY",
  "RESEARCH_INSTITUTION",
  "NEWS_OUTLET",
  "INDIVIDUAL",
  "ANONYMOUS",
  "UNKNOWN",
] as const;
export type ProvenanceEntityType = (typeof PROVENANCE_ENTITY_TYPE_VALUES)[number];

/**
 * How THIS article's text relates to the cited entity — a reporting
 * relationship, not a claim about the underlying facts' truth (see
 * src/lib/provenance/patterns.ts for why "primary" evidence never implies
 * "correct").
 */
export const PROVENANCE_RELATIONSHIP_TYPE_VALUES = [
  "CITES_WIRE_SERVICE",
  "CITES_OTHER_OUTLET",
  "CITES_PRIMARY_DOCUMENT",
  "CITES_STATEMENT",
  "ORIGINAL_REPORTING_CLAIM",
  "UNKNOWN",
] as const;
export type ProvenanceRelationshipType = (typeof PROVENANCE_RELATIONSHIP_TYPE_VALUES)[number];

/** What kind of documentary/testimonial artifact is behind the claim. */
export const PROVENANCE_EVIDENCE_TYPE_VALUES = [
  "STATEMENT",
  "PRESS_RELEASE",
  "COURT_FILING",
  "GOVERNMENT_DOCUMENT",
  "STUDY_OR_DATASET",
  "INTERVIEW",
  "EYEWITNESS_ACCOUNT",
  "REPORTING_CITATION",
  "UNKNOWN",
] as const;
export type ProvenanceEvidenceType = (typeof PROVENANCE_EVIDENCE_TYPE_VALUES)[number];

/**
 * The extractor's own internal classification includes LOW, but Phase 7B's
 * locked precision policy (false negative over false positive) means
 * persistObservations() must discard LOW before it ever reaches the
 * database — PERSISTABLE_CONFIDENCE_VALUES is the enforced subset.
 */
export const PROVENANCE_CONFIDENCE_VALUES = ["HIGH", "MEDIUM", "LOW"] as const;
export type ProvenanceConfidence = (typeof PROVENANCE_CONFIDENCE_VALUES)[number];

export const PERSISTABLE_CONFIDENCE_VALUES = ["HIGH", "MEDIUM"] as const;
export type PersistableConfidence = (typeof PERSISTABLE_CONFIDENCE_VALUES)[number];

export function isPersistableConfidence(
  value: ProvenanceConfidence,
): value is PersistableConfidence {
  return (PERSISTABLE_CONFIDENCE_VALUES as readonly string[]).includes(value);
}

/**
 * Which text buffer an observation's startOffset/endOffset refer to.
 * FEED_TEXT only exists for newly-ingested articles (the fuller sanitized
 * feed text available transiently before it's truncated to the stored
 * 220-char Article.excerpt — never itself persisted, see
 * src/lib/ingest/ingestSource.ts). Historical backfill can only ever
 * produce TITLE or STORED_EXCERPT_BACKFILL observations, since the fuller
 * text no longer exists for old articles — this distinction must never be
 * blurred (a backfilled observation must never imply it saw feed text it
 * didn't).
 */
export const PROVENANCE_EXTRACTION_SOURCE_VALUES = [
  "TITLE",
  "FEED_TEXT",
  "STORED_EXCERPT_BACKFILL",
] as const;
export type ProvenanceExtractionSource = (typeof PROVENANCE_EXTRACTION_SOURCE_VALUES)[number];

/** Whether an alias must match the exact case given, or case-insensitively. */
export const PROVENANCE_ALIAS_MATCH_TYPE_VALUES = ["EXACT", "CASE_INSENSITIVE"] as const;
export type ProvenanceAliasMatchType = (typeof PROVENANCE_ALIAS_MATCH_TYPE_VALUES)[number];

/** Where an alias row came from — never silently overwritten by reprocessing once ADMIN_OVERRIDE. */
export const PROVENANCE_ALIAS_SOURCE_VALUES = ["SEED", "LEARNED", "ADMIN_OVERRIDE"] as const;
export type ProvenanceAliasSource = (typeof PROVENANCE_ALIAS_SOURCE_VALUES)[number];

/** Foundation for future manual correction (no admin UI in Phase 7B). */
export const PROVENANCE_REVIEW_STATE_VALUES = [
  "UNREVIEWED",
  "ADMIN_OVERRIDE",
  "DISMISSED",
] as const;
export type ProvenanceReviewState = (typeof PROVENANCE_REVIEW_STATE_VALUES)[number];
