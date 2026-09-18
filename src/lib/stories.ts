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
