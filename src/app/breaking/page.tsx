import type { Metadata } from "next";
import { Flame } from "lucide-react";
import { listBreakingClusters } from "@/lib/stories";
import { getSiteUrl } from "@/lib/siteUrl";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildCollectionPageJsonLd } from "@/lib/seo/structuredData";
import { StoryCard } from "@/components/story/StoryCard";
import { EmptyState } from "@/components/ui/EmptyState";

const DESCRIPTION =
  "Stories flagged as breaking because at least three independent sources are actively reporting on them within the last 18 hours — a computed signal, not an editorial judgment.";

export const metadata: Metadata = {
  title: "Breaking News",
  description: DESCRIPTION,
  alternates: { canonical: `${getSiteUrl()}/breaking` },
};
export const revalidate = 30;

export default async function BreakingPage() {
  const clusters = await listBreakingClusters(30);
  const siteUrl = getSiteUrl();

  return (
    <div>
      <JsonLd
        data={buildCollectionPageJsonLd({
          name: "Breaking News",
          description: DESCRIPTION,
          url: `${siteUrl}/breaking`,
          siteUrl,
          items: clusters.map((c) => ({
            name: c.headline,
            url: `${siteUrl}/story/${encodeURIComponent(c.slug)}`,
          })),
        })}
      />
      <h1 className="mb-2 flex items-center gap-2 text-2xl font-extrabold tracking-tight text-breaking">
        <Flame size={22} /> Breaking News
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-foreground-muted">
        Stories are flagged as breaking when at least three independent sources are actively
        reporting on them within the last 18 hours. Nothing here is fabricated — if there&apos;s
        insufficient signal, this list is simply empty.
      </p>

      {clusters.length === 0 ? (
        <EmptyState
          icon={Flame}
          title="Nothing is currently breaking"
          description="No story has enough independent, recent coverage to meet the breaking-news threshold right now. Check back soon."
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => (
            <StoryCard key={cluster.id} cluster={cluster} />
          ))}
        </div>
      )}
    </div>
  );
}
