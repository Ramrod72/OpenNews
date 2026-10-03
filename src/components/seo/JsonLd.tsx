/**
 * Renders a schema.org object as an inline `<script type="application/
 * ld+json">`. `data` must already be a plain, JSON-serializable object —
 * build it with one of src/lib/seo/structuredData.ts's pure functions.
 *
 * Headlines/descriptions/source names ultimately originate from
 * publisher-controlled RSS feed text (untrusted input, same as every
 * other feed-derived string this app renders). `JSON.stringify` alone
 * does not escape `<`, so a value containing the literal text
 * `</script>` could otherwise break out of this tag and inject a sibling
 * `<script>` element — escaping `<` to its `<` JSON-string escape
 * (valid JSON, parses back to the identical string) closes that off
 * without needing an HTML-sanitization library for what is already a
 * JSON context, not an HTML one.
 */
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
