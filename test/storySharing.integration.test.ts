import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getStoryUrl } from "@/lib/share";
import { generateMetadata } from "@/app/story/[slug]/page";

let categoryId: string;
const clusterIds: string[] = [];

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-story-sharing", name: "Test Story Sharing", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.storyCluster.deleteMany({ where: { id: { in: clusterIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

interface ClusterOverrides {
  headline?: string;
  summary?: string | null;
  imageUrl?: string | null;
}

async function createCluster(overrides: ClusterOverrides = {}) {
  const cluster = await prisma.storyCluster.create({
    data: {
      headline: "Example headline",
      slug: `test-story-sharing-${Math.random().toString(36).slice(2)}`,
      categoryId,
      firstSeenAt: new Date(),
      lastUpdatedAt: new Date(),
      sourceCount: 1,
      articleCount: 1,
      ...overrides,
    },
  });
  clusterIds.push(cluster.id);
  return cluster;
}

/**
 * Next's `Metadata` type is authored for building metadata, not reading it
 * back — `openGraph`/`twitter` are large discriminated unions that don't
 * expose fields like `type`/`card` for simple property access once
 * assigned to the general `Metadata` type. Since this file is checking the
 * actual returned values (already proven correct at runtime), a loosely
 * typed view of just those two fields is the pragmatic way to assert on
 * them without fighting Next's authoring-oriented types.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value as Record<string, unknown> | undefined;
}

describe("generateMetadata for /story/[slug]", () => {
  it("returns a generic 'Story not found' title for an unknown slug, unchanged from before", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "does-not-exist-slug" }),
    });
    expect(metadata).toEqual({ title: "Story not found" });
  });

  it("story WITH an image: uses summary_large_image and includes the image in openGraph/twitter", async () => {
    const cluster = await createCluster({
      headline: "Markets react to policy shift",
      summary: "A short automated summary of the coverage.",
      imageUrl: "https://cdn.example.com/story-image.jpg",
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });

    const expectedUrl = getStoryUrl(cluster.slug);
    expect(metadata.title).toBe("Markets react to policy shift");
    expect(metadata.description).toBe("A short automated summary of the coverage.");
    expect(metadata.alternates?.canonical).toBe(expectedUrl);

    const openGraph = asRecord(metadata.openGraph);
    const twitter = asRecord(metadata.twitter);

    expect(openGraph?.title).toBe("Markets react to policy shift");
    expect(openGraph?.description).toBe("A short automated summary of the coverage.");
    expect(openGraph?.url).toBe(expectedUrl);
    expect(openGraph?.type).toBe("article");
    expect(openGraph?.images).toEqual(["https://cdn.example.com/story-image.jpg"]);

    expect(twitter?.card).toBe("summary_large_image");
    expect(twitter?.images).toEqual(["https://cdn.example.com/story-image.jpg"]);
  });

  it("story WITHOUT an image: falls back to a plain 'summary' twitter card and no images field", async () => {
    const cluster = await createCluster({
      headline: "A story with no lead image",
      summary: "Some summary text.",
      imageUrl: null,
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });
    const openGraph = asRecord(metadata.openGraph);
    const twitter = asRecord(metadata.twitter);

    expect(openGraph?.images).toBeUndefined();
    expect(twitter?.card).toBe("summary");
    expect(twitter?.images).toBeUndefined();
  });

  it("a missing summary never produces a fabricated description — description is omitted entirely, not a placeholder string", async () => {
    const cluster = await createCluster({ summary: null });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });

    expect(metadata.description).toBeUndefined();
    expect(asRecord(metadata.openGraph)?.description).toBeUndefined();
    expect(asRecord(metadata.twitter)?.description).toBeUndefined();
  });

  it("a whitespace-only/empty-string summary is treated the same as no summary at all", async () => {
    const cluster = await createCluster({ summary: "   " });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });

    expect(metadata.description).toBeUndefined();
    expect(asRecord(metadata.openGraph)?.description).toBeUndefined();
  });

  it("a headline with unusual characters (&, quotes, unicode, emoji) passes through untouched — Next/React handle HTML-escaping the actual <meta> tags", async () => {
    const tricky = `Tariffs & "trade wars"? — a café résumé story 😀`;
    const cluster = await createCluster({ headline: tricky });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });

    expect(metadata.title).toBe(tricky);
    expect(asRecord(metadata.openGraph)?.title).toBe(tricky);
    expect(asRecord(metadata.twitter)?.title).toBe(tricky);
  });

  it("the canonical/openGraph URL always points at the Veriqen story page, never a publisher URL", async () => {
    const cluster = await createCluster();
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: cluster.slug }) });

    const url = metadata.alternates?.canonical as string;
    expect(url).toContain(`/story/${cluster.slug}`);
    expect(url).not.toMatch(/^https?:\/\/(?!.*veriqen)(?!.*localhost).*$/i);
  });
});
