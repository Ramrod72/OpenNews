import { prisma } from "@/lib/db";
import { randomSuffix, slugify } from "@/lib/slug";
import { summarizeCluster } from "@/lib/ai";
import { averageVectors, buildTfIdfVectors, cosineSimilarity, type Vector } from "./tfidf";

const WINDOW_DAYS = 4;
const SIMILARITY_THRESHOLD = 0.32;
const BREAKING_MAX_AGE_HOURS = 18;
const BREAKING_MIN_SOURCES = 3;

interface RecentArticle {
  id: string;
  titleNormalized: string;
  excerpt: string | null;
  categoryId: string | null;
  sourceId: string;
  publishedAt: Date;
  clusterId: string | null;
}

/**
 * Groups recently-published articles into story clusters using TF-IDF
 * cosine similarity over titles (a practical, dependency-light approach
 * that runs entirely locally — no external clustering service required).
 * Only unclustered articles are (re)assigned; existing clusters act as
 * attractors so story URLs stay stable once created.
 */
export async function clusterRecentArticles(): Promise<{
  clustersCreated: number;
  clustersUpdated: number;
}> {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const categories = await prisma.category.findMany();
  let clustersCreated = 0;
  let clustersUpdated = 0;
  const changedClusterIds = new Set<string>();

  for (const category of categories) {
    const articles = (await prisma.article.findMany({
      where: { categoryId: category.id, publishedAt: { gte: windowStart } },
      select: {
        id: true,
        titleNormalized: true,
        excerpt: true,
        categoryId: true,
        sourceId: true,
        publishedAt: true,
        clusterId: true,
      },
      orderBy: { publishedAt: "asc" },
    })) as RecentArticle[];

    if (articles.length === 0) continue;

    const vectors = buildTfIdfVectors(articles.map((a) => ({ id: a.id, tokens: tokenize(a) })));

    type ActiveCluster = {
      id: string; // real StoryCluster id, or a `new:` temp id for this run
      isNew: boolean;
      memberIds: string[];
      centroid: Vector;
    };

    const active = new Map<string, ActiveCluster>();

    // Seed with existing clusters that already have recent members.
    const existingByCluster = new Map<string, RecentArticle[]>();
    for (const a of articles) {
      if (!a.clusterId) continue;
      const list = existingByCluster.get(a.clusterId) ?? [];
      list.push(a);
      existingByCluster.set(a.clusterId, list);
    }
    for (const [clusterId, members] of existingByCluster) {
      const centroid = averageVectors(members.map((m) => vectors.get(m.id)!));
      active.set(clusterId, {
        id: clusterId,
        isNew: false,
        memberIds: members.map((m) => m.id),
        centroid,
      });
    }

    const unclustered = articles.filter((a) => !a.clusterId);

    for (const article of unclustered) {
      const vector = vectors.get(article.id)!;
      let bestId: string | null = null;
      let bestScore = 0;

      for (const cluster of active.values()) {
        const score = cosineSimilarity(vector, cluster.centroid);
        if (score > bestScore) {
          bestScore = score;
          bestId = cluster.id;
        }
      }

      if (bestId && bestScore >= SIMILARITY_THRESHOLD) {
        const cluster = active.get(bestId)!;
        cluster.memberIds.push(article.id);
        cluster.centroid = averageVectors(cluster.memberIds.map((id) => vectors.get(id)!));
      } else {
        const tempId = `new:${article.id}`;
        active.set(tempId, { id: tempId, isNew: true, memberIds: [article.id], centroid: vector });
      }
    }

    // Persist.
    for (const cluster of active.values()) {
      const members = articles.filter((a) => cluster.memberIds.includes(a.id));
      const newMemberIds = members.filter((m) => !m.clusterId).map((m) => m.id);
      if (newMemberIds.length === 0 && cluster.isNew === false) continue; // nothing changed

      const publishedDates = members.map((m) => m.publishedAt.getTime());
      const firstSeenAt = new Date(Math.min(...publishedDates));
      const lastUpdatedAt = new Date(Math.max(...publishedDates));
      const sourceCount = new Set(members.map((m) => m.sourceId)).size;
      const articleCount = members.length;
      const { breaking, breakingScore } = computeBreaking(sourceCount, firstSeenAt);

      if (cluster.isNew) {
        const headlineArticle = members[0];
        const headlineRow = await prisma.article.findUnique({
          where: { id: headlineArticle.id },
          select: { title: true, imageUrl: true },
        });
        const headline = headlineRow?.title ?? "Untitled story";
        const slug = `${slugify(headline)}-${randomSuffix()}`;

        const created = await prisma.storyCluster.create({
          data: {
            headline,
            slug,
            categoryId: category.id,
            sourceCount,
            articleCount,
            firstSeenAt,
            lastUpdatedAt,
            breaking,
            breakingScore,
            imageUrl: headlineRow?.imageUrl ?? null,
          },
        });
        await prisma.article.updateMany({
          where: { id: { in: cluster.memberIds } },
          data: { clusterId: created.id },
        });
        clustersCreated += 1;
        changedClusterIds.add(created.id);
      } else {
        await prisma.storyCluster.update({
          where: { id: cluster.id },
          data: { sourceCount, articleCount, lastUpdatedAt, breaking, breakingScore },
        });
        if (newMemberIds.length > 0) {
          await prisma.article.updateMany({
            where: { id: { in: newMemberIds } },
            data: { clusterId: cluster.id },
          });
        }
        clustersUpdated += 1;
        changedClusterIds.add(cluster.id);
      }
    }
  }

  await refreshSummaries(Array.from(changedClusterIds));
  await refreshClusterKeywords(Array.from(changedClusterIds));

  return { clustersCreated, clustersUpdated };
}

function tokenize(article: Pick<RecentArticle, "titleNormalized" | "excerpt">): string[] {
  const titleTokens = article.titleNormalized.split(" ").filter(Boolean);
  const excerptTokens = (article.excerpt ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
  // Title terms count double: they're the strongest signal of "same story".
  return [...titleTokens, ...titleTokens, ...excerptTokens];
}

function computeBreaking(
  sourceCount: number,
  firstSeenAt: Date,
): { breaking: boolean; breakingScore: number } {
  const hoursSinceFirstSeen = (Date.now() - firstSeenAt.getTime()) / (60 * 60 * 1000);
  const breakingScore = Math.max(0, sourceCount * 3 - hoursSinceFirstSeen * 0.5);
  const breaking =
    sourceCount >= BREAKING_MIN_SOURCES && hoursSinceFirstSeen <= BREAKING_MAX_AGE_HOURS;
  return { breaking, breakingScore };
}

async function refreshClusterKeywords(clusterIds: string[]): Promise<void> {
  for (const clusterId of clusterIds) {
    try {
      const articleKeywords = await prisma.articleKeyword.findMany({
        where: { article: { clusterId } },
        select: { keywordId: true, weight: true },
      });
      const totals = new Map<string, number>();
      for (const ak of articleKeywords) {
        totals.set(ak.keywordId, (totals.get(ak.keywordId) ?? 0) + ak.weight);
      }
      for (const [keywordId, weight] of totals) {
        await prisma.clusterKeyword.upsert({
          where: { clusterId_keywordId: { clusterId, keywordId } },
          create: { clusterId, keywordId, weight },
          update: { weight },
        });
      }
    } catch (err) {
      console.error(`[cluster] failed to aggregate keywords for ${clusterId}:`, err);
    }
  }
}

async function refreshSummaries(clusterIds: string[]): Promise<void> {
  for (const clusterId of clusterIds) {
    try {
      const cluster = await prisma.storyCluster.findUnique({
        where: { id: clusterId },
        include: { articles: { orderBy: { publishedAt: "asc" }, include: { source: true } } },
      });
      if (!cluster) continue;
      const summary = await summarizeCluster(cluster);
      if (summary) {
        await prisma.storyCluster.update({ where: { id: clusterId }, data: { summary } });
      }
    } catch (err) {
      console.error(`[cluster] failed to summarize ${clusterId}:`, err);
    }
  }
}
