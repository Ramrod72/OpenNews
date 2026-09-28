import sanitizeHtml from "sanitize-html";

/**
 * Feed content is untrusted external input. We never render it as HTML
 * (no dangerouslySetInnerHTML anywhere in the app) — instead every piece
 * of text pulled from a feed is reduced to plain text here before it's
 * stored or displayed. This removes the XSS surface entirely rather than
 * trying to allowlist "safe" markup.
 */
export function toPlainText(input: string | undefined | null, maxLength = 4000): string {
  if (!input) return "";

  const stripped = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text.replace(/\s+/g, " "),
  });

  const decoded = decodeEntities(stripped)
    // Strip non-whitespace control characters (NUL and other C0/C1 codes) —
    // \s already collapses tab/newline/CR into a space above, but a raw
    // NUL byte in particular isn't whitespace and isn't valid in a
    // Postgres TEXT column, so it must never reach storage even though
    // SQLite (used in dev) silently accepts it.
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return decoded.length > maxLength ? `${decoded.slice(0, maxLength - 1).trimEnd()}…` : decoded;
}

/**
 * sanitize-html's tag stripping doesn't always decode entities left over in
 * plain text nodes (e.g. a feed's `&amp;` staying literal), so decode the
 * common ones ourselves. Order matters: `&amp;` must be decoded last so
 * something like `&amp;lt;` correctly becomes the literal text `&lt;`
 * rather than being double-unescaped into `<`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Truncate already-sanitized plain text to a card-friendly length without
 * cutting mid-word. Split out from excerpt() so a caller that needs the
 * fuller sanitized text for its own purposes before truncation (Phase 7B's
 * provenance extraction — see src/lib/ingest/ingestSource.ts) can sanitize
 * once and reuse it, rather than sanitizing the same raw input twice.
 */
export function truncatePlainText(plain: string, maxLength = 220): string {
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLength).trimEnd()}…`;
}

/** Sanitize raw (possibly-HTML) input to plain text, then truncate to a card-friendly length. */
export function excerpt(text: string, maxLength = 220): string {
  return truncatePlainText(toPlainText(text, 8000), maxLength);
}

/** Only allow http(s) image URLs through; anything else (data:, javascript:, ...) is dropped. */
export function safeImageUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
