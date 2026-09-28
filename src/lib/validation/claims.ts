/**
 * Closed sets of allowed values for the Phase 10B claim model (Claim) —
 * plain strings validated here at the application layer, not Prisma enums,
 * matching this schema's established Postgres/SQLite-portability
 * convention (see src/lib/validation/provenance.ts's direct precedent).
 * Extending any list here is a one-line change, not a migration.
 *
 * extractionSource, reviewState, and extraction confidence are
 * DELIBERATELY NOT redefined here — Claim reuses
 * PROVENANCE_EXTRACTION_SOURCE_VALUES, PROVENANCE_REVIEW_STATE_VALUES, and
 * PERSISTABLE_CONFIDENCE_VALUES from ./provenance.ts verbatim, so claim
 * extraction and provenance extraction can never silently drift apart on
 * what these shared concepts mean.
 */

/**
 * Phase 10B's locked MVP taxonomy (see AGENTS-facing spec): ONLY these two
 * kinds are ever extracted or persisted. DIRECT_QUOTE, generic declarative
 * claims, opinion/prediction/allegation extraction are explicitly out of
 * scope — adding a new kind here without updating every consumer of
 * CLAIM_KIND_VALUES (extraction, grouping, view model, UI copy) would be a
 * scope violation of the locked MVP boundary, not just a one-line change.
 */
export const CLAIM_KIND_VALUES = ["NUMERICAL_ASSERTION", "ATTRIBUTED_STATEMENT"] as const;
export type ClaimKind = (typeof CLAIM_KIND_VALUES)[number];

/**
 * Deliberately small, closed set — precision over recall. A number whose
 * surrounding context doesn't match one of these recognized units is not
 * extracted as a NUMERICAL_ASSERTION at all (see claims/numberPatterns.ts)
 * rather than being extracted with an "UNKNOWN"/catch-all unit, which
 * would invite exactly the kind of low-value, hard-to-compare noise this
 * module must avoid.
 */
export const CLAIM_NUMERIC_UNIT_VALUES = [
  "PEOPLE",
  "DEATHS",
  "INJURIES",
  "ARRESTS",
  "PERCENT",
  "USD",
  "MAGNITUDE",
  "YEARS",
  "VOTES",
  "ACRES",
  "MILES",
  "KILOMETERS",
] as const;
export type ClaimNumericUnit = (typeof CLAIM_NUMERIC_UNIT_VALUES)[number];

/**
 * A numerical assertion's qualifier changes what it actually asserts —
 * "12 injured" and "at least 12 injured" are related but NOT
 * interchangeable, and "12 injured" vs. "fewer than 12 injured" are
 * near-opposites. Grouping logic (claims/buildClaimGroups.ts) must never
 * silently equate different qualifiers; EXACT is the default when no
 * qualifier phrase is detected.
 */
export const CLAIM_NUMERIC_QUALIFIER_VALUES = [
  "EXACT",
  "AT_LEAST",
  "MORE_THAN",
  "AT_MOST",
  "LESS_THAN",
  "APPROXIMATE",
] as const;
export type ClaimNumericQualifier = (typeof CLAIM_NUMERIC_QUALIFIER_VALUES)[number];
