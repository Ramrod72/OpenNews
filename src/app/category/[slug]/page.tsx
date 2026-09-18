import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { listStoryClusters } from "@/lib/stories";
import { StoryCard } from "@/components/story/StoryCard";
import { LoadMoreStories } from "@/components/story/LoadMoreStories";
import { EmptyState } from "@/components/ui/EmptyState";
import { AdContainer } from "@/components/ads/AdContainer";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const category = await prisma.category.findUnique({ where: { slug } });
  return { title: category?.name ?? "Category" };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const category = await prisma.category.findUnique({ where: { slug } });
  if (!category) notFound();

  const { clusters, nextCursor } = await listStoryClusters({ categorySlug: slug, limit: 12 });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">{category.name}</h1>

      {clusters.length === 0 ? (
        <EmptyState
          title="No stories in this category yet"
          description="Once the ingestion worker runs against the configured feeds, stories will appear here."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {clusters.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>
          <LoadMoreStories initialCursor={nextCursor} query={{ category: slug }} />
        </>
      )}

      <div className="mt-8">
        <AdContainer slot="betweenStories" />
      </div>
    </div>
  );
}
