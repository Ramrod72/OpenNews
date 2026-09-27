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

/** The normalized site origin, from NEXT_PUBLIC_SITE_URL or the dev fallback. */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  return normalizeSiteUrl(
    configured && configured.trim().length > 0 ? configured : DEV_FALLBACK_SITE_URL,
  );
}
