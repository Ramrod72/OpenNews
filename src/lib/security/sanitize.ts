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

  const decoded = decodeEntities(stripped).replace(/\s+/g, " ").trim();

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

/** Truncate a plain-text excerpt to a card-friendly length without cutting mid-word. */
export function excerpt(text: string, maxLength = 220): string {
  const plain = toPlainText(text, 8000);
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLength).trimEnd()}…`;
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
