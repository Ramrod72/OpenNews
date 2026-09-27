import { getSiteUrl } from "./siteUrl";

/**
 * The canonical, absolute Veriqen URL for a story. This is the only URL
 * sharing/metadata code should ever build or hand to a share destination —
 * never a publisher/article URL. Kept as a plain function (not baked into
 * a component) so both `generateMetadata` and the share UI compute the
 * exact same value from the exact same source.
 */
export function getStoryUrl(slug: string, siteUrl: string = getSiteUrl()): string {
  return `${siteUrl}/story/${slug}`;
}

export interface ShareTarget {
  url: string;
  title: string;
}

/**
 * Every builder below uses URLSearchParams so title text containing `&`,
 * `?`, `#`, quotes, or Unicode/emoji is always percent-encoded correctly —
 * never hand-built with string concatenation/template literals.
 */

export function buildXShareUrl({ url, title }: ShareTarget): string {
  const params = new URLSearchParams({ text: title, url });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

/**
 * Facebook's sharer has not reliably honored a prefilled quote/text param
 * for years (an anti-abuse change on their end) — `u` is the only
 * dependable field, so that's all this sends.
 */
export function buildFacebookShareUrl({ url }: Pick<ShareTarget, "url">): string {
  const params = new URLSearchParams({ u: url });
  return `https://www.facebook.com/sharer/sharer.php?${params.toString()}`;
}

export function buildRedditShareUrl({ url, title }: ShareTarget): string {
  const params = new URLSearchParams({ url, title });
  return `https://www.reddit.com/submit?${params.toString()}`;
}

/**
 * LinkedIn's current share-offsite endpoint only accepts `url` — it reads
 * title/description from the target page's own Open Graph tags rather
 * than a URL param, so there's nothing else useful to pass here.
 */
export function buildLinkedInShareUrl({ url }: Pick<ShareTarget, "url">): string {
  const params = new URLSearchParams({ url });
  return `https://www.linkedin.com/sharing/share-offsite/?${params.toString()}`;
}

export function buildWhatsAppShareUrl({ url, title }: ShareTarget): string {
  const params = new URLSearchParams({ text: `${title} ${url}` });
  return `https://wa.me/?${params.toString()}`;
}
