import { getSiteUrl } from "@/lib/siteUrl";

/**
 * Pure builders for the schema.org JSON-LD this app emits. Deliberately
 * conservative: every builder here describes Veriqen News's own page
 * (a WebSite/Organization/CollectionPage/WebPage it operates), never the
 * underlying third-party journalism a story page aggregates. In
 * particular, no builder in this file ever sets `author` or `publisher`
 * to Veriqen News on anything that represents reporting written by a
 * publisher (BBC, Reuters, AP, ...) — see buildStoryWebPageJsonLd's own
 * doc comment, and test/structuredDataSafety.test.ts, which enforces this
 * structurally.
 */

export const ORGANIZATION_NAME = "Veriqen News";

export interface JsonLdBreadcrumbItem {
  name: string;
  url: string;
}

export interface JsonLdListItem {
  name: string;
  url: string;
}

/** Site-wide identity — who operates this site. Emitted once, in the root layout. */
export function buildOrganizationJsonLd(siteUrl: string = getSiteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: ORGANIZATION_NAME,
    url: siteUrl,
  };
}

/**
 * Site-wide WebSite identity plus a SearchAction describing the real,
 * working /search?q= query parameter this app already supports (see
 * src/app/search/page.tsx) — never a fabricated or unsupported capability.
 */
export function buildWebSiteJsonLd(siteUrl: string = getSiteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORGANIZATION_NAME,
    url: siteUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${siteUrl}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/**
 * A listing/index page this app operates (category, /sources, /latest,
 * /breaking) — truthfully a CollectionPage, never a NewsArticle or any
 * type that would claim authorship over the items it lists.
 * `items`, when given, must be real, currently-rendered entries on the
 * page (never a superset, never fabricated) — callers pass exactly what
 * they render, nothing more.
 */
export function buildCollectionPageJsonLd({
  name,
  description,
  url,
  items,
  siteUrl = getSiteUrl(),
}: {
  name: string;
  description?: string;
  url: string;
  items?: JsonLdListItem[];
  siteUrl?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    ...(description ? { description } : {}),
    url,
    isPartOf: { "@type": "WebSite", name: ORGANIZATION_NAME, url: siteUrl },
    ...(items && items.length > 0
      ? {
          mainEntity: {
            "@type": "ItemList",
            itemListElement: items.map((item, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: item.name,
              url: item.url,
            })),
          },
        }
      : {}),
  };
}

/**
 * The /story/[slug] page itself: a WebPage Veriqen News operates that
 * aggregates and analyzes third-party reporting — NEVER a NewsArticle,
 * and NEVER given an `author`/`publisher`/`creator` naming Veriqen News
 * or anyone else, since Veriqen News did not write the underlying
 * journalism and has no authority to assert authorship on a publisher's
 * behalf. The distinct publishers whose reporting the page aggregates are
 * referenced only through schema.org's `mentions` relationship — "this
 * page mentions these organizations," never "this page was written by
 * them" or "Veriqen News is their publisher."
 */
export function buildStoryWebPageJsonLd({
  headline,
  description,
  url,
  sources,
  siteUrl = getSiteUrl(),
}: {
  headline: string;
  description?: string;
  url: string;
  sources: Array<{ name: string; homepageUrl: string | null }>;
  siteUrl?: string;
}) {
  const uniqueSources = Array.from(new Map(sources.map((s) => [s.name, s])).values());

  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: headline,
    ...(description ? { description } : {}),
    url,
    isPartOf: { "@type": "WebSite", name: ORGANIZATION_NAME, url: siteUrl },
    ...(uniqueSources.length > 0
      ? {
          mentions: uniqueSources.map((source) => ({
            "@type": "Organization",
            name: source.name,
            ...(source.homepageUrl ? { url: source.homepageUrl } : {}),
          })),
        }
      : {}),
  };
}

/** Visible breadcrumb trail's matching structured data — must list the exact same items, in the same order, as the visible <Breadcrumbs> component it accompanies. */
export function buildBreadcrumbListJsonLd(items: JsonLdBreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
