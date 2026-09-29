/**
 * Runtime output-language validator for Phase 11B. This is a SECOND,
 * independent safety layer, not a substitute for the system-instruction
 * language policy (storyBrief/prompt.ts) — a model can and will ignore or
 * misinterpret instructions, especially under prompt injection (see
 * storyBrief/prompt.ts's own doc comment), so every word of
 * model-GENERATED text is checked here before it is ever validated as
 * grounded (schema.ts) or rendered to a user.
 *
 * Unlike test/coverageComparisonSafety.test.ts's Phase 10 forbidden-phrase
 * check (which scans STATIC UI copy and must tolerate a negated
 * explanatory sentence like "does not mean independently confirmed"),
 * this validator scans MODEL-GENERATED prose whose narrow job — describing
 * repetition, differences, and source overlap already detected by
 * Phases 7-10 — never legitimately requires any of these words in any
 * form. The bare terms are therefore forbidden outright, with no negation
 * exception: the model has no legitimate reason to write "confirmed" (in
 * any sentence) when synthesizing an AI Story Brief.
 */

const FORBIDDEN_TERMS: RegExp[] = [
  /\bconfirms?(ed|ing)?\b/i,
  /\b(?:un)?verif(y|ies|ied|ying|ication)\b/i,
  /\bcorroborat(e|es|ed|ing|ion)\b/i,
  /\bindependently confirmed\b/i,
  /\btrue\b/i,
  /\bfalse\b/i,
  /\blies?\b/i,
  /\blying\b/i,
  /\bprov(e|es|ed|ing)\b/i,
  /\bdisprov(e|es|ed|ing)\b/i,
  /\bpropaganda\b/i,
  /\bbiased?\b/i,
  /\breliable\b/i,
  /\bunreliable\b/i,
  /\bomit(s|ted|ting)?\b/i,
  /\bhid(e|es|ing|den)?\b/i,
  /\bfailed to report\b/i,
  /\bsame dispatch\b/i,
  /\bcopied\b/i,
  /\bplagiari[sz]ed\b/i,
];

/** Returns the first forbidden term found in `text`, or null if the text is clean. */
export function findForbiddenLanguage(text: string): string | null {
  for (const pattern of FORBIDDEN_TERMS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function containsForbiddenLanguage(text: string): boolean {
  return findForbiddenLanguage(text) !== null;
}
