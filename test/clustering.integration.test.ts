import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { clusterRecentArticles } from "@/lib/clustering/cluster";
import { hashUrl, normalizeTitle, normalizeUrl } from "@/lib/ingest/normalize";

let categoryId: string;
let sourceAId: string;
let sourceBId: string;
let sourceCId: string;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-world", name: "Test World", order: 999 },
  });
  categoryId = category.id;

  const [a, b, c] = await Promise.all([
    prisma.source.create({
      data: { name: "Source A", url: "https://a.example.com/feed.xml", categorySlug: "test-world" },
    }),
    prisma.source.create({
      data: { name: "Source B", url: "https://b.example.com/feed.xml", categorySlug: "test-world" },
    }),
    prisma.source.create({
      data: { name: "Source C", url: "https://c.example.com/feed.xml", categorySlug: "test-world" },
    }),
  ]);
  sourceAId = a.id;
  sourceBId = b.id;
  sourceCId = c.id;
});

afterAll(async () => {
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.source.deleteMany({ where: { id: { in: [sourceAId, sourceBId, sourceCId] } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

function makeArticleInput(title: string, sourceId: string, url: string, publishedAt: Date) {
  return {
    sourceId,
    url,
    urlHash: hashUrl(normalizeUrl(url)),
    title,
    titleNormalized: normalizeTitle(title),
    excerpt: `Coverage of: ${title}`,
    categoryId,
    publishedAt,
  };
}

describe("duplicate detection (DB constraint)", () => {
  it("rejects a second article with the same normalized URL", async () => {
    const url = "https://a.example.com/story-1?utm_source=rss";
    await prisma.article.create({
      data: makeArticleInput("A unique duplicate-detection headline", sourceAId, url, new Date()),
    });

    await expect(
      prisma.article.create({
        data: makeArticleInput(
          "A unique duplicate-detection headline",
          sourceAId,
          "https://a.example.com/story-1/", // same normalized URL after stripping tracking param + trailing slash
          new Date(),
        ),
      }),
    ).rejects.toThrow();
  });
});

describe("clusterRecentArticles", () => {
  it("groups near-identical headlines from different sources into one story cluster", async () => {
    const now = new Date();
    await prisma.article.createMany({
      data: [
        makeArticleInput(
          "Senate passes major climate bill after late vote",
          sourceAId,
          "https://a.example.com/climate-bill",
          now,
        ),
        makeArticleInput(
          "Senate approves climate bill following late-night vote",
          sourceBId,
          "https://b.example.com/climate-bill",
          now,
        ),
        makeArticleInput(
          "Senate votes to pass sweeping climate legislation",
          sourceCId,
          "https://c.example.com/climate-bill",
          now,
        ),
      ],
    });

    await clusterRecentArticles();

    const clusters = await prisma.storyCluster.findMany({
      where: { categoryId },
      include: { articles: true },
    });

    expect(clusters.length).toBeGreaterThan(0);
    const mainCluster = clusters.find((c) => c.articleCount >= 2);
    expect(mainCluster).toBeDefined();
    expect(mainCluster!.sourceCount).toBeGreaterThanOrEqual(2);
  });

  it("does not merge an unrelated story into the same cluster", async () => {
    const now = new Date();
    await prisma.article.create({
      data: makeArticleInput(
        "Local bakery wins regional pastry championship award",
        sourceAId,
        "https://a.example.com/bakery-award",
        now,
      ),
    });

    await clusterRecentArticles();

    const bakeryArticle = await prisma.article.findFirst({
      where: { url: "https://a.example.com/bakery-award" },
      include: { cluster: { include: { articles: true } } },
    });

    expect(bakeryArticle?.cluster).toBeTruthy();
    // The bakery story should not have been folded into the (unrelated) climate-bill cluster.
    const clusterHeadlines = bakeryArticle!.cluster!.articles.map((a) => a.title);
    expect(clusterHeadlines.some((t) => /climate/i.test(t))).toBe(false);
  });
});
