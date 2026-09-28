import { normalizeTitle } from "@/lib/ingest/normalize";

/**
 * Conservative, deterministic text normalization for CLAIM GROUPING
 * COMPARISON ONLY — the result is never itself displayed to a consumer
 * (see coverageComparisonView.ts, which always uses a claim's own rawText
 * for any user-visible representative text). Reuses normalizeTitle
 * (src/lib/ingest/normalize.ts) verbatim rather than reimplementing
 * lowercase/diacritic-stripping/punctuation-removal/stopword-filtering a
 * second time — the exact same bounded operation set Phase 10B's spec
 * allows (lowercase, Unicode-safe whitespace normalization, punctuation
 * removal, conservative tokenization), already implemented, tested, and
 * proven safe against hostile input by Phase 1-5.
 *
 * Deliberately does NOT attempt word-number normalization ("twelve" -> 12)
 * for this MVP — numberPatterns.ts only ever matches digit-based numbers
 * to begin with, so a word-form number is never extracted as a
 * NUMERICAL_ASSERTION at all (a false negative, and therefore safe by this
 * module's own precision-first policy) rather than silently mismatched
 * against a digit-form equivalent.
 */
export function normalizeClaimText(text: string): string {
  return normalizeTitle(text);
}

/** Tokenizes already-normalized text into a Set, for cheap subject/entity-overlap checks. */
export function claimTokenSet(normalizedText: string): Set<string> {
  return new Set(normalizedText.split(" ").filter(Boolean));
}
