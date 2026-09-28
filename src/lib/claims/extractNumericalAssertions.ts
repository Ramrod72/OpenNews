import { NEGATION_WORDS } from "@/lib/provenance/patterns";
import { findNumberCandidates, suppressOverlappingCandidates } from "./numberPatterns";
import { findContainingSentence, splitSentences } from "./sentenceBoundary";
import type { ClaimNumericQualifier, ClaimNumericUnit } from "@/lib/validation/claims";

const DEFAULT_MAX_RAW_TEXT_LENGTH = 200;

/**
 * Bare "N people" is the least specific unit rule (no predicate verb
 * anchors it to a particular kind of event) — MEDIUM rather than HIGH,
 * exactly mirroring provenance/extract.ts's own confidence-tiering
 * philosophy (a short/ambiguous match stays lower-confidence even when
 * otherwise well-formed). Every other unit requires a specific,
 * unambiguous keyword/symbol immediately adjacent to the number and stays
 * HIGH.
 */
const MEDIUM_CONFIDENCE_UNITS: ReadonlySet<ClaimNumericUnit> = new Set(["PEOPLE"]);

export interface ExtractedNumericalClaim {
  kind: "NUMERICAL_ASSERTION";
  unit: ClaimNumericUnit;
  numericValue: number;
  qualifier: ClaimNumericQualifier;
  /** Bounded snippet of the containing sentence — never the full input text. */
  rawText: string;
  startOffset: number;
  endOffset: number;
  confidence: "HIGH" | "MEDIUM";
}

/**
 * A candidate is discarded entirely (never even considered "MEDIUM") when
 * its containing sentence carries a negation word anywhere in it —
 * deliberately coarse (whole-sentence, not just a tight grammatical gap)
 * because this module has no reliable dependency parse to scope negation
 * more precisely, and a false negative here (a real, non-negated numeric
 * assertion discarded because an unrelated word in the same sentence
 * happens to be "not") is vastly preferable to a false equivalence (a
 * genuinely negated assertion — "3 arrests were not confirmed" —
 * persisted and compared as if it positively asserted "3 arrests").
 */
function sentenceContainsNegation(sentenceText: string): boolean {
  const words = sentenceText
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  return words.some((w) => NEGATION_WORDS.has(w));
}

function boundText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLength).trimEnd()}…`;
}

/**
 * Pure orchestration: split into sentences, find number candidates,
 * suppress overlaps, discard anything in a negated sentence, and bound the
 * resulting raw text to a sentence-level snippet. No DB access, no I/O.
 * Deterministic: identical input always produces identical output in the
 * same order (sentence order, then match order within a sentence).
 */
export function extractNumericalAssertions(
  text: string,
  options?: { maxRawTextLength?: number },
): ExtractedNumericalClaim[] {
  if (!text || !text.trim()) return [];

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const maxRawTextLength = options?.maxRawTextLength ?? DEFAULT_MAX_RAW_TEXT_LENGTH;
  const accepted = suppressOverlappingCandidates(findNumberCandidates(text));

  const results: ExtractedNumericalClaim[] = [];
  for (const candidate of accepted) {
    const sentence = findContainingSentence(sentences, candidate.startOffset, candidate.endOffset);
    if (!sentence) continue; // defensive: a span always comes from the same text sentences were split from
    if (sentenceContainsNegation(sentence.text)) continue;

    results.push({
      kind: "NUMERICAL_ASSERTION",
      unit: candidate.unit,
      numericValue: candidate.numericValue,
      qualifier: candidate.qualifier,
      rawText: boundText(sentence.text, maxRawTextLength),
      startOffset: sentence.startOffset,
      endOffset: sentence.endOffset,
      confidence: MEDIUM_CONFIDENCE_UNITS.has(candidate.unit) ? "MEDIUM" : "HIGH",
    });
  }

  // Deterministic order: by position in the text, then by unit name for a
  // stable tie-break when two candidates share a start offset (shouldn't
  // normally happen after overlap suppression, but never leave order to
  // object-key iteration chance).
  results.sort((a, b) => a.startOffset - b.startOffset || a.unit.localeCompare(b.unit));
  return results;
}
