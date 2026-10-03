import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

const clusterCardInclude = {
  category: true,
  articles: {
    orderBy: { publishedAt: "asc" as const },
    include: { source: true },
  },
} satisfies Prisma.StoryClusterInclude;

export type StoryClusterCard = Prisma.StoryClusterGetPayload<{
  include: typeof clusterCardInclude;
}>;

export interface ListStoriesOptions {
  categorySlug?: string;
  breakingOnly?: boolean;
  sourceId?: string;
  sort?: "latest" | "oldest";
  limit?: number;
  cursor?: string;
}

export async function listStoryClusters(options: ListStoriesOptions = {}): Promise<{
  clusters: StoryClusterCard[];
  nextCursor: string | null;
}> {
  const limit = Math.min(options.limit ?? 20, 60);

  const where: Prisma.StoryClusterWhereInput = {};
  if (options.categorySlug) where.category = { slug: options.categorySlug };
  if (options.breakingOnly) where.breaking = true;
  if (options.sourceId) where.articles = { some: { sourceId: options.sourceId } };

  const clusters = await prisma.storyCluster.findMany({
    where,
    include: clusterCardInclude,
    orderBy: { lastUpdatedAt: options.sort === "oldest" ? "asc" : "desc" },
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = clusters.length > limit;
  const page = hasMore ? clusters.slice(0, limit) : clusters;

  return { clusters: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

export interface ListStoriesPageOptions {
  categorySlug?: string;
  breakingOnly?: boolean;
  sourceId?: string;
  sort?: "latest" | "oldest";
  page?: number;
  pageSize?: number;
}

export interface StoriesPage {
  clusters: StoryClusterCard[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Numeric offset/page-number pagination, deliberately separate from
 * listStoryClusters's cursor-based pagination above (used by `/api/stories`
 * and the client-side "Load more" enhancement) — a real page count needs a
 * total row count up front, which a cursor API was never designed to
 * provide cheaply. Used by /category/[slug] so later pages are reachable
 * through real, deterministic `?page=N` URLs a crawler can follow, not
 * only through a client-side fetch.
 */
export async function listStoryClustersByPage(
  options: ListStoriesPageOptions = {},
): Promise<StoriesPage> {
  // Defense-in-depth: the only current caller (/category/[slug]) already
  // sanitizes its page param before calling this, but this function must
  // never trust that. Number.isSafeInteger rejects NaN, Infinity, non-
  // integers, and anything beyond Number.MAX_SAFE_INTEGER (e.g. 1e21) —
  // any of those, or a non-positive value, would otherwise reach the
  // `(page - 1) * pageSize` arithmetic below and produce a `skip` value
  // Prisma/SQLite were never meant to receive. Falls back to page 1,
  // exactly like the route's own invalid-page handling.
  const rawPage = options.page ?? 1;
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(options.pageSize ?? 20, 60);

  const where: Prisma.StoryClusterWhereInput = {};
  if (options.categorySlug) where.category = { slug: options.categorySlug };
  if (options.breakingOnly) where.breaking = true;
  if (options.sourceId) where.articles = { some: { sourceId: options.sourceId } };

  const [total, clusters] = await Promise.all([
    prisma.storyCluster.count({ where }),
    prisma.storyCluster.findMany({
      where,
      include: clusterCardInclude,
      orderBy: { lastUpdatedAt: options.sort === "oldest" ? "asc" : "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
  ]);

  return { clusters, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getStoryClusterBySlug(slug: string): Promise<StoryClusterCard | null> {
  return prisma.storyCluster.findUnique({
    where: { slug },
    include: clusterCardInclude,
  });
}

export async function getRelatedClusters(
  cluster: StoryClusterCard,
  limit = 6,
): Promise<StoryClusterCard[]> {
  if (!cluster.categoryId) return [];
  return prisma.storyCluster.findMany({
    where: { categoryId: cluster.categoryId, id: { not: cluster.id } },
    include: clusterCardInclude,
    orderBy: { lastUpdatedAt: "desc" },
    take: limit,
  });
}

export async function listCategories() {
  return prisma.category.findMany({ orderBy: { order: "asc" } });
}

export async function listActiveSources() {
  return prisma.source.findMany({
    where: { active: true },
    select: { id: true, name: true, homepageUrl: true, categorySlug: true },
    orderBy: { name: "asc" },
  });
}

/** Breaking = clusters flagged by the clustering engine's breaking-news heuristic. */
export async function listBreakingClusters(limit = 5): Promise<StoryClusterCard[]> {
  return prisma.storyCluster.findMany({
    where: { breaking: true },
    include: clusterCardInclude,
    orderBy: { breakingScore: "desc" },
    take: limit,
  });
}

export { clusterCardInclude };
