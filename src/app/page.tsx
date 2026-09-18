import Link from "next/link";
import { ArrowRight, Flame, Inbox } from "lucide-react";
import { listBreakingClusters, listCategories, listStoryClusters } from "@/lib/stories";
import { StoryCard } from "@/components/story/StoryCard";
import { AdContainer } from "@/components/ads/AdContainer";
import { EmptyState } from "@/components/ui/EmptyState";

export const revalidate = 60;

export default async function HomePage() {
  const [breaking, top, latest, categories] = await Promise.all([
    listBreakingClusters(4),
    listStoryClusters({ limit: 7 }),
    listStoryClusters({ limit: 8, sort: "latest" }),
    listCategories(),
  ]);

  const totalStories = top.clusters.length;

  if (totalStories === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No stories yet"
        description="OpenNews hasn't ingested any articles yet. Run the ingestion worker to pull in the configured RSS feeds: `npm run ingest` (one-off) or `npm run worker` (continuous). See DEPLOYMENT.md for running it alongside the web app."
      />
    );
  }

  const [featured, ...rest] = top.clusters;

  return (
    <div className="flex flex-col gap-10">
      {breaking.length > 0 && (
        <section aria-labelledby="breaking-heading">
          <SectionHeading
            id="breaking-heading"
            icon={<Flame size={16} className="text-breaking" />}
            title="Breaking News"
            href="/breaking"
          />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {breaking.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="top-heading">
        <SectionHeading id="top-heading" title="Top Stories" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <StoryCard cluster={featured} variant="featured" />
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border p-2">
            {rest.slice(0, 5).map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} variant="compact" />
            ))}
          </div>
        </div>
      </section>

      <AdContainer slot="homepageFeed" />

      <section
        aria-labelledby="latest-heading"
        className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"
      >
        <div>
          <SectionHeading id="latest-heading" title="Latest" href="/latest" />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {latest.clusters.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>
        </div>
        <aside className="hidden lg:block">
          <AdContainer slot="sidebar" />
        </aside>
      </section>

      {categories.map((category) => (
        <CategoryRow key={category.id} slug={category.slug} name={category.name} />
      ))}
    </div>
  );
}

function SectionHeading({
  id,
  title,
  href,
  icon,
}: {
  id: string;
  title: string;
  href?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 id={id} className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
        {icon}
        {title}
      </h2>
      {href && (
        <Link
          href={href}
          className="flex items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          See all <ArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}

async function CategoryRow({ slug, name }: { slug: string; name: string }) {
  const { clusters } = await listStoryClusters({ categorySlug: slug, limit: 4 });
  if (clusters.length === 0) return null;

  return (
    <section aria-labelledby={`cat-${slug}`}>
      <SectionHeading id={`cat-${slug}`} title={name} href={`/category/${slug}`} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {clusters.map((cluster) => (
          <StoryCard key={cluster.id} cluster={cluster} />
        ))}
      </div>
    </section>
  );
}
