/**
 * Base origin Veriqen is served from, e.g. "https://veriqen.example.com".
 * Used to build absolute URLs (canonical links, Open Graph/Twitter card
 * metadata, share targets) from server code that doesn't have access to
 * the current request — metadata generation can run at build time for
 * statically-rendered pages, where there is no request to read a Host
 * header from.
 *
 * Falls back to a local dev origin so `npm run dev`/`next build` work
 * without any production configuration. Set NEXT_PUBLIC_SITE_URL to the
 * real deployment origin for production (see .env.example / DEPLOYMENT.md).
 * NEXT_PUBLIC_-prefixed so the same value is available to client
 * components without extra plumbing, though nothing here reads secrets —
 * a site's own public URL is not sensitive.
 */
const DEV_FALLBACK_SITE_URL = "http://localhost:3000";

/**
 * Strips trailing slashes (one or more) so callers can safely build
 * `${normalizeSiteUrl(x)}/story/${slug}` without ever producing a
 * double slash, regardless of whether the configured value ends in "/".
 */
export function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Reduces a configured value down to a bare, safe origin
 * (`protocol://host[:port]`), discarding any path/query/fragment/userinfo
 * a misconfigured value might carry. This matters beyond tidiness: naive
 * `${siteUrl}/story/${slug}` concatenation breaks silently if `siteUrl`
 * already has a `?query` or `#fragment` (everything after `/story/` gets
 * swallowed into that query/fragment instead of becoming a path segment),
 * and this app has no supported subpath deployment, so a bare origin is
 * always what's wanted here. Also rejects a non-http(s) scheme
 * (`javascript:`/`data:`/`file:`) and embedded credentials
 * (`https://user:pass@host`), the same checks already applied to every
 * other URL this app treats as a link target (see
 * src/lib/validation/sourceProfile.ts's `httpUrl`). Returns null for
 * anything unparseable or unsafe, rather than throwing — the one caller
 * that constructs a `URL` from this value (`metadataBase` in
 * src/app/layout.tsx) would otherwise crash the entire app at startup on
 * a single bad environment variable.
 */
function toSafeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** The normalized, validated site origin, from NEXT_PUBLIC_SITE_URL or the dev fallback. */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    const safe = toSafeOrigin(configured);
    if (safe) return normalizeSiteUrl(safe);
    if (process.env.NODE_ENV === "production") {
      console.warn(
        `[siteUrl] NEXT_PUBLIC_SITE_URL is set to an invalid or unsafe value (${JSON.stringify(
          configured,
        )}) — it must be a bare http(s) origin with no path, query, fragment, or ` +
          "credentials. Falling back to the local development origin, which is almost " +
          "certainly wrong in production — fix NEXT_PUBLIC_SITE_URL (see .env.example).",
      );
    }
  }
  return DEV_FALLBACK_SITE_URL;
}
