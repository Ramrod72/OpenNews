const LEADING_COMMON_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "on",
  "at",
  "as",
  "by",
  "of",
  "and",
  "or",
  "but",
  "for",
  "with",
  "after",
  "before",
  "how",
  "why",
  "what",
  "when",
  "who",
  "amid",
  "it",
  "this",
  "these",
  "those",
  "his",
  "her",
  "their",
  "why",
  "watch",
  "live",
  "breaking",
  "exclusive",
  "opinion",
  "analysis",
]);

/**
 * Heuristic entity/topic extraction: runs of Capitalized Words in the
 * original (non-lowercased) title, e.g. "New York Times", "European
 * Union", "NASA". This is a lightweight, dependency-free stand-in for full
 * named-entity recognition — good enough to power topic browsing and
 * search filters without requiring any external NLP service. When an AI
 * provider is configured it can be swapped in later for higher recall.
 */
export function extractKeywordPhrases(title: string): string[] {
  const matches = title.match(/\b[A-Z][a-zA-Z.'’-]*(?:\s+[A-Z][a-zA-Z.'’-]*)*\b/g) ?? [];

  const phrases = new Map<string, number>();
  for (const raw of matches) {
    const words = raw.trim().split(/\s+/);
    // Drop a leading common word ("The White House" -> keep; "The" alone -> drop)
    while (words.length > 1 && LEADING_COMMON_WORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    const phrase = words.join(" ").trim();
    if (phrase.length < 3) continue;
    if (words.length === 1 && LEADING_COMMON_WORDS.has(phrase.toLowerCase())) continue;
    if (/^[A-Z]$/.test(phrase)) continue; // stray single letter

    const key = phrase;
    phrases.set(key, (phrases.get(key) ?? 0) + 1);
  }

  return Array.from(phrases.keys()).slice(0, 8);
}
