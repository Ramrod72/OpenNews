import { listStoryClusters } from "@/lib/stories";
import { StoryCard } from "@/components/story/StoryCard";
import { LoadMoreStories } from "@/components/story/LoadMoreStories";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Latest" };
export const revalidate = 30;

export default async function LatestPage() {
  const { clusters, nextCursor } = await listStoryClusters({ limit: 15, sort: "latest" });

  return (
    <div>
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
