/**
 * Conservative, deterministic near-duplicate text detection over
 * Article.excerpt (the already-stored, already-sanitized 220-char plain
 * text — never any longer buffer, never re-fetched). Word-level shingles
 * + Jaccard overlap only, no regex-based fuzzy matching, no NLP
 * dependency, matching the Phase 8B spec's explicit mandate.
 *
 * This is a SUPPORTING, corroborating-only signal — see types.ts's
 * NearDuplicateTextSignal and getClusterOriginSummary.ts's Reuters/AP
 * note. High word-shingle overlap between two articles' excerpts MAY
 * reflect shared/syndicated source text (e.g. two outlets both lightly
 * editing the same wire dispatch); it is never proof of exact dispatch
 * identity, and callers must never label it anything stronger than
 * "LIKELY_SHARED_TEXT_ORIGIN".
 */

/** Consecutive-word shingle size. 3 balances precision (fewer coincidental overlaps than 2) against recall (still works on a 220-char excerpt, unlike a larger size). */
export const SHINGLE_SIZE = 3;

/**
 * Conservative similarity floor — deliberately high. False negative over
 * false positive: a merely-similar pair of excerpts (same topic, same
 * quoted number) should NOT trigger this signal; only excerpts that are
 * substantially the same wording should.
 */
export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/**
 * Hard cap on how many articles a single candidate group's excerpts are
 * pairwise-compared within. Near-duplicate detection is only ever run
 * INSIDE an already-narrowed group (e.g. one resolved-entity's citing
 * articles — see buildSourceGroups.ts), never across a whole cluster, but
 * even within one group, naive all-pairs comparison is O(k^2). A cluster
 * where 1,000 articles all cite Reuters must not turn into ~500,000
 * pairwise comparisons. Past this cap, the group is simply too large to
 * safely compare exhaustively at query time, and no near-duplicate-text
 * signal is produced for it — an intentional false-negative-over-false-
 * positive/performance tradeoff, not an oversight (see ARCHITECTURE.md's
 * Phase 8B section and Phase 8B's test O).
 */
export const MAX_GROUP_SIZE_FOR_TEXT_COMPARISON = 25;

/**
 * Minimum normalized word count an excerpt must have before it's even
 * considered for near-duplicate comparison. Below the shingle size, two
 * short excerpts collapse to a single whole-text "shingle" each — so two
 * merely coincidentally-identical short fragments (a malformed/boilerplate
 * excerpt like "Breaking News" or "Read more.") would otherwise score a
 * perfect 1.0 similarity from almost no real evidence, a genuine false-
 * positive risk under the false-negative-over-false-positive policy. Set
 * comfortably above SHINGLE_SIZE so a real comparison has enough distinct
 * shingles to be meaningful, not just one degenerate whole-text shingle.
 */
export const MIN_WORDS_FOR_COMPARISON = 8;

function normalizeToWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wordShingles(words: string[], size: number): Set<string> {
  if (words.length === 0) return new Set();
  if (words.length < size) return new Set([words.join(" ")]);
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - size; i++) {
    shingles.add(words.slice(i, i + size).join(" "));
  }
  return shingles;
}

/**
 * Jaccard similarity of normalized word shingles, in [0, 1]. Pure,
 * deterministic, no I/O. Returns 0 for empty/whitespace-only input on
 * either side (never divides by zero, never throws).
 */
export function excerptJaccardSimilarity(textA: string, textB: string): number {
  const wordsA = normalizeToWords(textA);
  const wordsB = normalizeToWords(textB);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const shinglesA = wordShingles(wordsA, SHINGLE_SIZE);
  const shinglesB = wordShingles(wordsB, SHINGLE_SIZE);
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;

  let intersection = 0;
  const [smaller, larger] =
    shinglesA.size <= shinglesB.size ? [shinglesA, shinglesB] : [shinglesB, shinglesA];
  for (const shingle of smaller) {
    if (larger.has(shingle)) intersection += 1;
  }

  const union = shinglesA.size + shinglesB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ExcerptCandidate {
  articleId: string;
  excerpt: string;
}

export interface NearDuplicatePair {
  articleIdA: string;
  articleIdB: string;
  similarity: number;
}

function normalizedWordCount(text: string): number {
  return normalizeToWords(text).length;
}

/**
 * All pairs within ONE already-narrowed candidate group whose excerpts
 * clear NEAR_DUPLICATE_SIMILARITY_THRESHOLD. Deterministic output order
 * (stable relative to input order). Returns [] without comparing anything
 * when the group exceeds MAX_GROUP_SIZE_FOR_TEXT_COMPARISON — this is the
 * function's ONLY job in keeping the whole module's near-duplicate-text
 * analysis linear in total article count: callers must never call this
 * across a whole cluster, only within a pre-partitioned group (see
 * buildSourceGroups.ts). A candidate whose excerpt normalizes to fewer
 * than MIN_WORDS_FOR_COMPARISON words is excluded from comparison
 * entirely (never paired, never flagged) — this is a policy decision
 * about what's trustworthy enough to surface as a signal, kept separate
 * from excerptJaccardSimilarity's own general-purpose, length-agnostic
 * similarity math.
 */
export function findNearDuplicatePairs(
  candidates: ExcerptCandidate[],
  threshold: number = NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
): NearDuplicatePair[] {
  const withText = candidates.filter(
    (c) =>
      c.excerpt &&
      c.excerpt.trim().length > 0 &&
      normalizedWordCount(c.excerpt) >= MIN_WORDS_FOR_COMPARISON,
  );
  if (withText.length > MAX_GROUP_SIZE_FOR_TEXT_COMPARISON) return [];

  const pairs: NearDuplicatePair[] = [];
  for (let i = 0; i < withText.length; i++) {
    for (let j = i + 1; j < withText.length; j++) {
      const similarity = excerptJaccardSimilarity(withText[i]!.excerpt, withText[j]!.excerpt);
      if (similarity >= threshold) {
        pairs.push({
          articleIdA: withText[i]!.articleId,
          articleIdB: withText[j]!.articleId,
          similarity,
        });
      }
    }
  }
  return pairs;
}
