import type { StoryClusterCard } from "@/lib/stories";

export function serializeCluster(cluster: StoryClusterCard) {
  const sources = Array.from(
    new Map(cluster.articles.map((a) => [a.source.id, a.source])).values(),
  );

  return {
    id: cluster.id,
    slug: cluster.slug,
    headline: cluster.headline,
    summary: cluster.summary,
    category: cluster.category
      ? { slug: cluster.category.slug, name: cluster.category.name }
      : null,
    imageUrl: cluster.imageUrl,
    breaking: cluster.breaking,
    sourceCount: cluster.sourceCount,
    articleCount: cluster.articleCount,
    firstSeenAt: cluster.firstSeenAt.toISOString(),
    lastUpdatedAt: cluster.lastUpdatedAt.toISOString(),
    sources: sources.map((s) => ({ id: s.id, name: s.name, homepageUrl: s.homepageUrl })),
    articles: cluster.articles.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      excerpt: a.excerpt,
      imageUrl: a.imageUrl,
      author: a.author,
      publishedAt: a.publishedAt.toISOString(),
      source: { id: a.source.id, name: a.source.name, homepageUrl: a.source.homepageUrl },
    })),
  };
}

export type SerializedCluster = ReturnType<typeof serializeCluster>;
