import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { clusterCardInclude, type StoryClusterCard } from "@/lib/stories";

export interface SearchOptions {
  q?: string;
  categorySlug?: string;
  sourceId?: string;
  sort?: "relevance" | "newest" | "oldest";
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  results: StoryClusterCard[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Bound how many structurally-matching clusters we pull into memory for
// text scoring. SQLite and Postgres disagree on case-insensitive `contains`
// semantics (Prisma's `mode: "insensitive"` isn't supported on SQLite), so
// free-text relevance is computed in application code over this candidate
// set rather than pushed down as SQL — simple, portable across both
// databases, and plenty fast at self-hosted-news-aggregator scale. A
// database-side full-text index (SQLite FTS5 / Postgres tsvector) is a
// natural upgrade path if a deployment outgrows this; see ARCHITECTURE.md.
const CANDIDATE_LIMIT = 800;

export async function searchStories(options: SearchOptions): Promise<SearchResult> {
  const page = Math.max(options.page ?? 1, 1);
  const pageSize = Math.min(options.pageSize ?? 20, 50);

  const where: Prisma.StoryClusterWhereInput = {};
  if (options.categorySlug) where.category = { slug: options.categorySlug };
  if (options.sourceId) where.articles = { some: { sourceId: options.sourceId } };

  const dateFilter: Prisma.DateTimeFilter = {};
  if (options.dateFrom) dateFilter.gte = new Date(options.dateFrom);
  if (options.dateTo) dateFilter.lte = new Date(options.dateTo);
  if (options.dateFrom || options.dateTo) where.lastUpdatedAt = dateFilter;

  const candidates = await prisma.storyCluster.findMany({
    where,
    include: clusterCardInclude,
    orderBy: { lastUpdatedAt: "desc" },
    take: CANDIDATE_LIMIT,
  });

  const query = options.q?.trim().toLowerCase() ?? "";
  let scored: Array<{ cluster: StoryClusterCard; score: number }>;

  if (!query) {
    scored = candidates.map((cluster) => ({ cluster, score: 0 }));
  } else {
    scored = candidates
      .map((cluster) => ({ cluster, score: relevanceScore(cluster, query) }))
      .filter((entry) => entry.score > 0);
  }

  scored.sort((a, b) => {
    if (options.sort === "oldest") {
      return a.cluster.firstSeenAt.getTime() - b.cluster.firstSeenAt.getTime();
    }
    if (options.sort === "newest") {
      return b.cluster.lastUpdatedAt.getTime() - a.cluster.lastUpdatedAt.getTime();
    }
    // relevance (default when a query is present, otherwise falls back to recency)
    if (query)
      return (
        b.score - a.score || b.cluster.lastUpdatedAt.getTime() - a.cluster.lastUpdatedAt.getTime()
      );
    return b.cluster.lastUpdatedAt.getTime() - a.cluster.lastUpdatedAt.getTime();
  });

  const total = scored.length;
  const start = (page - 1) * pageSize;
  const results = scored.slice(start, start + pageSize).map((e) => e.cluster);

  return { results, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function relevanceScore(cluster: StoryClusterCard, query: string): number {
  let score = 0;
  if (cluster.headline.toLowerCase().includes(query)) score += 10;
  if (cluster.summary?.toLowerCase().includes(query)) score += 4;

  for (const article of cluster.articles) {
    if (article.title.toLowerCase().includes(query)) score += 3;
    if (article.excerpt?.toLowerCase().includes(query)) score += 1;
    if (article.source.name.toLowerCase().includes(query)) score += 2;
  }

  // Modest boost for stories with broader confirmed coverage, so a
  // well-corroborated match doesn't lose to a single tangential mention.
  if (score > 0) score += Math.min(cluster.sourceCount, 5) * 0.5;

  return score;
}
