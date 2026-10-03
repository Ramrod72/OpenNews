import type { Metadata } from "next";
import { listStoryClusters } from "@/lib/stories";
import { getSiteUrl } from "@/lib/siteUrl";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildCollectionPageJsonLd } from "@/lib/seo/structuredData";
import { StoryCard } from "@/components/story/StoryCard";
import { LoadMoreStories } from "@/components/story/LoadMoreStories";
import { EmptyState } from "@/components/ui/EmptyState";

const DESCRIPTION = "The most recently updated story clusters, newest first.";

export const metadata: Metadata = {
  title: "Latest",
  description: DESCRIPTION,
  alternates: { canonical: `${getSiteUrl()}/latest` },
};
export const revalidate = 30;

export default async function LatestPage() {
  const { clusters, nextCursor } = await listStoryClusters({ limit: 15, sort: "latest" });
  const siteUrl = getSiteUrl();

  return (
    <div>
      <JsonLd
        data={buildCollectionPageJsonLd({
          name: "Latest",
          description: DESCRIPTION,
          url: `${siteUrl}/latest`,
          siteUrl,
          items: clusters.map((c) => ({
            name: c.headline,
            url: `${siteUrl}/story/${encodeURIComponent(c.slug)}`,
          })),
        })}
      />
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Latest</h1>
      {clusters.length === 0 ? (
        <EmptyState title="Nothing published yet" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {clusters.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>
          <LoadMoreStories initialCursor={nextCursor} query={{ sort: "latest" }} />
        </>
      )}
    </div>
  );
}
