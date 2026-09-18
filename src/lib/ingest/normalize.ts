import { createHash } from "node:crypto";

// Tracking/session params that don't change the identity of an article but
// would otherwise defeat URL-based dedupe.
const TRACKING_PARAM_PREFIXES = ["utm_", "ic_", "icid", "ito", "cmp"];
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "spref",
  "s",
  "CMP",
  "intcid",
  "taid",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
]);

/** Canonicalize a URL for dedupe: strip tracking params, fragment, trailing slash, lowercase host. */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const params = Array.from(url.searchParams.keys());
  for (const key of params) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(key) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
      url.searchParams.delete(key);
    }
  }
  url.search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  url.pathname = pathname;

  return url.toString();
}

export function hashUrl(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
  "by",
  "it",
  "its",
  "this",
  "that",
  "after",
  "before",
  "amid",
  "over",
  "into",
  "from",
  "than",
  "says",
  "say",
  "said",
  "new",
  "up",
  "out",
  "will",
  "has",
  "have",
  "had",
  "about",
]);

/** Lowercase, strip punctuation and stopwords — used for both storage and similarity comparisons. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .join(" ");
}

export function titleTokens(normalizedTitle: string): Set<string> {
  return new Set(normalizedTitle.split(" ").filter(Boolean));
}

/** Jaccard similarity of token sets, 0..1. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
