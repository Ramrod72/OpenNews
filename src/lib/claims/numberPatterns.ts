import type { ClaimNumericQualifier, ClaimNumericUnit } from "@/lib/validation/claims";

/**
 * Deterministic, dependency-free numerical-assertion pattern matching —
 * same philosophy as src/lib/provenance/patterns.ts: trust only explicit,
 * narrow, literal constructions; never guess. A bare, isolated number is
 * NEVER extracted — every rule below requires a specific, closed-set unit
 * keyword/symbol immediately adjacent to the number (see
 * CLAIM_NUMERIC_UNIT_VALUES's own doc comment on why the set stays small).
 */

export interface NumberCandidate {
  unit: ClaimNumericUnit;
  numericValue: number;
  qualifier: ClaimNumericQualifier;
  /** Offset of the full matched clause (qualifier phrase, if any, through the unit word), into the text this matcher was given. */
  startOffset: number;
  endOffset: number;
}

interface UnitRule {
  unit: ClaimNumericUnit;
  /** Must contain exactly one capturing group for the raw numeric token. */
  pattern: RegExp;
}

const NUMBER_TOKEN = "[\\d][\\d,]*(?:\\.\\d+)?";

// Deliberately narrow, literal constructions only — see this module's own
// doc comment. Order matters only for readability; overlap suppression
// (suppressOverlappingCandidates below) resolves any span conflicts.
const UNIT_RULES: UnitRule[] = [
  {
    unit: "USD",
    pattern: new RegExp(
      `\\$\\s?(${NUMBER_TOKEN})\\s?(?:billion|million|thousand|trillion)?\\b`,
      "gi",
    ),
  },
  // \b only applies to the word form ("percent") — the symbol form ("%")
  // is itself a non-word character, so a trailing \b would never match
  // when "%" is immediately followed by punctuation (e.g. "63%.", the
  // ordinary end of a sentence) since \b requires a word/non-word
  // transition, and non-word-to-non-word never qualifies.
  { unit: "PERCENT", pattern: new RegExp(`(${NUMBER_TOKEN})\\s?(?:%|percent\\b)`, "gi") },
  {
    unit: "MAGNITUDE",
    pattern: new RegExp(`\\bmagnitude[\\s-]?(?:of\\s+)?(${NUMBER_TOKEN})\\b`, "gi"),
  },
  { unit: "MAGNITUDE", pattern: new RegExp(`\\b(${NUMBER_TOKEN})[\\s-]?magnitude\\b`, "gi") },
  {
    unit: "DEATHS",
    pattern: new RegExp(
      `\\b(${NUMBER_TOKEN})\\s+(?:people\\s+)?(?:were\\s+|was\\s+)?(?:killed|dead|died)\\b`,
      "gi",
    ),
  },
  {
    unit: "INJURIES",
    pattern: new RegExp(
      `\\b(${NUMBER_TOKEN})\\s+(?:people\\s+)?(?:were\\s+|was\\s+)?(?:injured|hurt|wounded)\\b`,
      "gi",
    ),
  },
  {
    unit: "ARRESTS",
    pattern: new RegExp(
      `\\b(${NUMBER_TOKEN})\\s+(?:people\\s+)?(?:were\\s+|was\\s+)?arrested\\b`,
      "gi",
    ),
  },
  { unit: "ARRESTS", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+arrests\\b`, "gi") },
  { unit: "VOTES", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+votes\\b`, "gi") },
  { unit: "ACRES", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+acres\\b`, "gi") },
  { unit: "MILES", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+miles\\b`, "gi") },
  { unit: "KILOMETERS", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+(?:kilometers|km)\\b`, "gi") },
  // Bare "N people" (attending, gathering, etc.) — lowest-specificity
  // rule, deliberately last: a more specific rule's longer match span
  // (e.g. INJURIES's "12 people were injured") always contains and
  // therefore suppresses this one (see suppressOverlappingCandidates).
  { unit: "PEOPLE", pattern: new RegExp(`\\b(${NUMBER_TOKEN})\\s+people\\b`, "gi") },
  // Deadline-style years — narrow on purpose: only when an explicit
  // deadline/due keyword immediately precedes the year, never a bare year.
  {
    unit: "YEARS",
    pattern: new RegExp(
      `\\b(?:deadline|due|expires?)\\s+(?:of\\s+|in\\s+|by\\s+)?((?:19|20)\\d{2})\\b`,
      "gi",
    ),
  },
  { unit: "YEARS", pattern: new RegExp(`\\bby\\s+((?:19|20)\\d{2})\\b`, "gi") },
];

/** Qualifier phrases checked immediately before a number token — order matters (checked in this order, first match wins). */
const QUALIFIER_RULES: { qualifier: ClaimNumericQualifier; re: RegExp }[] = [
  { qualifier: "AT_LEAST", re: /\bat least\s*$/i },
  { qualifier: "MORE_THAN", re: /\bmore than\s*$/i },
  { qualifier: "MORE_THAN", re: /\bover\s*$/i },
  { qualifier: "AT_MOST", re: /\bat most\s*$/i },
  { qualifier: "AT_MOST", re: /\bup to\s*$/i },
  { qualifier: "LESS_THAN", re: /\bfewer than\s*$/i },
  { qualifier: "LESS_THAN", re: /\bless than\s*$/i },
  { qualifier: "LESS_THAN", re: /\bunder\s*$/i },
  { qualifier: "APPROXIMATE", re: /\b(?:about|approximately|roughly|nearly|around)\s*$/i },
];

const QUALIFIER_WINDOW_CHARS = 20;

function detectQualifier(
  text: string,
  matchStart: number,
): { qualifier: ClaimNumericQualifier; extraStart: number } {
  const windowStart = Math.max(0, matchStart - QUALIFIER_WINDOW_CHARS);
  const window = text.slice(windowStart, matchStart);
  for (const { qualifier, re } of QUALIFIER_RULES) {
    const m = re.exec(window);
    if (m) {
      return { qualifier, extraStart: windowStart + m.index! };
    }
  }
  return { qualifier: "EXACT", extraStart: matchStart };
}

const MULTIPLIERS: Record<string, number> = {
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000,
};

/**
 * Bounds the parsed numeric value to a sane range — a hostile/malformed
 * feed cannot cause an unbounded or non-finite numericValue to reach
 * persistence (see claims/persistClaims.ts's own defensive caps).
 */
export const MAX_NUMERIC_VALUE = 1_000_000_000_000; // one trillion — already the largest legitimate multiplier

function parseNumberToken(raw: string, fullMatch: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  let value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;

  const multiplierMatch = /\b(thousand|million|billion|trillion)\b/i.exec(fullMatch);
  if (multiplierMatch) {
    value *= MULTIPLIERS[multiplierMatch[1]!.toLowerCase()]!;
  }

  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMERIC_VALUE) return null;
  return value;
}

/**
 * Finds all numeric-assertion candidates in `text`, each anchored to a
 * recognized unit and with qualifier detection applied. Does NOT apply
 * negation filtering or overlap suppression — callers (see
 * extractNumericalAssertions.ts) compose this with sentence-boundary
 * negation checks and suppressOverlappingCandidates.
 */
export function findNumberCandidates(text: string): NumberCandidate[] {
  const candidates: NumberCandidate[] = [];

  for (const rule of UNIT_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const raw = match[1];
      if (!raw) continue;

      // A "-" (or en/em dash) immediately adjacent to the digit, with no
      // space, means either a negative sign our unit rules don't support
      // (e.g. hostile "-5 people were injured") or, far more commonly in
      // real news text, a written-out range ("10-12 people were injured")
      // whose second number this rule would otherwise silently present as
      // if it were the sole exact assertion — a false-precision claim
      // about text that never actually asserted one definite number.
      // Refusing extraction here (precision over recall) is safer than
      // guessing which end of a range, or whether a sign, was meant.
      const charBefore = text[match.index - 1];
      if (charBefore === "-" || charBefore === "–" || charBefore === "—") continue;

      const numericValue = parseNumberToken(raw, match[0]);
      if (numericValue === null) continue;

      const { qualifier, extraStart } = detectQualifier(text, match.index);
      candidates.push({
        unit: rule.unit,
        numericValue,
        qualifier,
        startOffset: Math.min(extraStart, match.index),
        endOffset: match.index + match[0].length,
      });
    }
  }

  return candidates;
}

/**
 * Keeps the longer/more-specific match when two candidates' spans overlap
 * — identical algorithm to provenance/extract.ts's suppressOverlaps (kept
 * as a separate, local copy rather than a shared import: the two modules'
 * candidate shapes differ, and this is a small, generic, easily-verified
 * utility, not worth coupling two otherwise-independent extraction
 * pipelines over).
 */
export function suppressOverlappingCandidates(candidates: NumberCandidate[]): NumberCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    return b.endOffset - b.startOffset - (a.endOffset - a.startOffset);
  });

  const accepted: NumberCandidate[] = [];
  for (const candidate of sorted) {
    const containedInAccepted = accepted.some(
      (a) => candidate.startOffset >= a.startOffset && candidate.endOffset <= a.endOffset,
    );
    if (!containedInAccepted) accepted.push(candidate);
  }
  return accepted;
}
