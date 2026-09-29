/**
 * A small, deterministic, dependency-free sentence-boundary splitter —
 * NOT a linguistic parser. It exists solely so Phase 10B can answer "which
 * sentence contains this span?" (used to bound a numerical-assertion match
 * and to find the sentence a Phase 7 attribution observation sits inside —
 * see extractNumericalAssertions.ts / buildAttributedStatementClaims.ts).
 * It intentionally does not attempt to be linguistically correct for every
 * edge case; it only needs to be safe (never throw, never hang, bounded
 * output) and good enough that a reasonable sentence boundary is found for
 * ordinary news-style text.
 */

export interface Sentence {
  text: string;
  startOffset: number;
  endOffset: number;
}

/** Hard cap on how many sentences one text buffer is ever split into — defensive, mirrors this module's caps-everywhere convention. */
export const MAX_SENTENCES_PER_TEXT = 100;

/**
 * Common abbreviations whose trailing period must NOT be treated as a
 * sentence boundary. Deliberately small and news-domain-focused; a missed
 * abbreviation only produces one sentence spanning two real sentences
 * (harmless — extraction still finds spans correctly within it), so this
 * list errs toward simplicity over completeness.
 */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "inc",
  "corp",
  "co",
  "ltd",
  "gov",
  "sen",
  "rep",
  "gen",
  "col",
  "lt",
  "capt",
  "u.s",
  "u.k",
  "u.n",
  "a.m",
  "p.m",
]);

function precedingWordIsAbbreviation(text: string, periodIndex: number): boolean {
  // Walk backward from the period to the start of the preceding word.
  let start = periodIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1]!)) start -= 1;
  const word = text.slice(start, periodIndex).toLowerCase();
  return ABBREVIATIONS.has(word);
}

/**
 * Splits `text` into sentences with correct offsets into the ORIGINAL
 * string. A sentence boundary is a `.`/`!`/`?` followed by whitespace and
 * an uppercase letter (or end of string), except immediately after a
 * recognized abbreviation. Bounded: stops producing new sentences past
 * MAX_SENTENCES_PER_TEXT (the remainder of the text is folded into the
 * final sentence) — a pathological "a. b. c. ..." input can never produce
 * unbounded output.
 */
export function splitSentences(text: string): Sentence[] {
  if (!text || !text.trim()) return [];

  const sentences: Sentence[] = [];
  let start = 0;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === "." && precedingWordIsAbbreviation(text, i)) continue;

    // Require the boundary to be followed by whitespace then an uppercase
    // letter/digit, or to be the end of the string — avoids splitting
    // mid-number ("3.5") or mid-ellipsis awkwardly more than necessary.
    const rest = text.slice(i + 1);
    const boundaryMatch = /^(\s+)([A-Z0-9"'“‘(]|$)/.exec(rest);
    if (!boundaryMatch && i !== len - 1) continue;

    const end = i + 1;
    const sentenceText = text.slice(start, end).trim();
    if (sentenceText) {
      sentences.push({ text: sentenceText, startOffset: start, endOffset: end });
    }
    start = end;

    if (sentences.length >= MAX_SENTENCES_PER_TEXT) break;
  }

  if (start < len && sentences.length < MAX_SENTENCES_PER_TEXT) {
    const tailText = text.slice(start).trim();
    if (tailText) {
      sentences.push({ text: tailText, startOffset: start, endOffset: len });
    }
  } else if (sentences.length >= MAX_SENTENCES_PER_TEXT && start < len) {
    // Pathological input: fold whatever remains into the last sentence
    // rather than dropping it or looping further.
    const last = sentences[sentences.length - 1]!;
    sentences[sentences.length - 1] = {
      text: text.slice(last.startOffset, len).trim(),
      startOffset: last.startOffset,
      endOffset: len,
    };
  }

  return sentences;
}

/** Finds the sentence (if any) whose span fully contains [spanStart, spanEnd). Returns null if no sentence contains it (should not normally happen for a span taken from the same text). */
export function findContainingSentence(
  sentences: readonly Sentence[],
  spanStart: number,
  spanEnd: number,
): Sentence | null {
  for (const s of sentences) {
    if (spanStart >= s.startOffset && spanEnd <= s.endOffset) return s;
  }
  return null;
}
