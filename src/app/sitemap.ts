import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";
import { getSiteUrl } from "@/lib/siteUrl";
import { isSourceProfileIndexable, toPublicSourceProfile } from "@/lib/sourceProfile";

// Next's own sitemap limit (50,000 URLs per file, after which it requires
// generateSitemaps()-based splitting) is nowhere near relevant at this
// project's actual scale — dozens of configured sources (see
// config/sources.json) and, realistically, low thousands of story
// clusters at most for a self-hosted aggregator. These caps are a
// defensive ceiling, not a response to measured scale, so a single plain
// sitemap() is deliberately all this implements; revisit only if a real
// deployment's story-cluster count approaches this bound.
const MAX_STORY_URLS = 2000;
const MAX_SOURCE_URLS = 1000;

// Without this, Next treats sitemap() as a plain static route (no
// dynamic API usage) and prerenders it ONCE at `next build` — which, in
// this project's Docker build, runs against an intentionally empty
// placeholder database (see Dockerfile's DATABASE_URL=file:./build-
// placeholder.db), permanently freezing every category/source/story URL
// out of the shipped sitemap. This route segment config makes Next
// revalidate (re-run this function against the real database) at most
// once per hour in production, the same ISR pattern every other
// DB-backed page in this app already uses (see page.tsx, sources/page.tsx,
// latest/page.tsx, breaking/page.tsx, category/[slug]/page.tsx).
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();

  const [categories, sources, clusters] = await Promise.all([
    prisma.category.findMany({ orderBy: { order: "asc" } }),
    prisma.source.findMany({
      where: { active: true },
      include: { externalAssessments: true },
      orderBy: { name: "asc" },
      take: MAX_SOURCE_URLS,
    }),
    prisma.storyCluster.findMany({
      orderBy: { lastUpdatedAt: "desc" },
      take: MAX_STORY_URLS,
      select: { slug: true, lastUpdatedAt: true },
    }),
  ]);

  // Static routes. None of these have a real "last modified" moment — the
  // page is a live, continuously-recomposed view, not a document with an
  // edit timestamp — so `lastModified` is deliberately omitted rather than
  // invented. /account, /bookmarks, /login, /register, and every /admin*
  // and /api* route are excluded: they're private, personalized, or not
  // real content pages (see robots.ts and each route's own `robots`
  // metadata for the authoritative noindex signal).
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${siteUrl}/about`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${siteUrl}/pricing`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${siteUrl}/sources`, changeFrequency: "daily", priority: 0.5 },
    { url: `${siteUrl}/latest`, changeFrequency: "hourly", priority: 0.7 },
    { url: `${siteUrl}/breaking`, changeFrequency: "hourly", priority: 0.7 },
    { url: `${siteUrl}/search`, changeFrequency: "weekly", priority: 0.2 },
  ];

  // Categories have no stored "last modified" moment of their own (just a
  // display `order`), so none is invented here either.
  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${siteUrl}/category/${category.slug}`,
    changeFrequency: "hourly",
    priority: 0.6,
  }));

  // Only "eligible" profiles — see isSourceProfileIndexable's own doc
  // comment — are listed; a sparse profile stays reachable via /sources
  // and internal links, it's just not advertised to crawlers here, for
  // the same reason its own page carries `noindex`.
  const sourceEntries: MetadataRoute.Sitemap = sources
    .filter((source) => isSourceProfileIndexable(toPublicSourceProfile(source)))
    .map((source) => ({
      url: `${siteUrl}/sources/${source.id}`,
      ...(source.profileUpdatedAt ? { lastModified: source.profileUpdatedAt } : {}),
      changeFrequency: "monthly",
      priority: 0.4,
    }));

  // lastUpdatedAt is a real, meaningful signal here — it's the same
  // timestamp the clustering engine bumps whenever a new article joins
  // the story, so it genuinely reflects when the page's content last
  // changed.
  const storyEntries: MetadataRoute.Sitemap = clusters.map((cluster) => ({
    url: `${siteUrl}/story/${encodeURIComponent(cluster.slug)}`,
    lastModified: cluster.lastUpdatedAt,
    changeFrequency: "daily",
    priority: 0.5,
  }));

  return [...staticEntries, ...categoryEntries, ...sourceEntries, ...storyEntries];
}
