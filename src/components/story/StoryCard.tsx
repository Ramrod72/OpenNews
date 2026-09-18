import Link from "next/link";
import Image from "next/image";
import { Layers, Newspaper } from "lucide-react";
import { relativeTime } from "@/lib/format";
import { BreakingBadge, CategoryBadge } from "@/components/ui/CategoryBadge";
import { BookmarkButton } from "./BookmarkButton";

type Variant = "featured" | "default" | "compact";

/**
 * Structural subset shared by both the server-rendered Prisma shape
 * (StoryClusterCard) and the JSON API's serialized shape, so this
 * component works whether it's rendered directly in a server component or
 * fed data fetched client-side (e.g. "load more" pagination).
 */
export interface StoryCardData {
  id: string;
  slug: string;
  headline: string;
  summary: string | null;
  imageUrl: string | null;
  breaking: boolean;
  sourceCount: number;
  lastUpdatedAt: Date | string;
  category: { slug: string; name: string } | null;
  articles: Array<{ excerpt: string | null; source: { name: string } }>;
}

export function StoryCard({
  cluster,
  variant = "default",
}: {
  cluster: StoryCardData;
  variant?: Variant;
}) {
  const leadArticle = cluster.articles[0];
  const excerpt = cluster.summary || leadArticle?.excerpt || "";

  if (variant === "compact") {
    return (
      <Link
        href={`/story/${cluster.slug}`}
        className="group flex items-center gap-3 rounded-lg p-2 hover:bg-surface-muted"
      >
        <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded-md bg-surface-muted">
          {cluster.imageUrl ? (
            <Image
              src={cluster.imageUrl}
              alt=""
              fill
              sizes="80px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <PlaceholderArt />
          )}
        </div>
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-semibold text-foreground group-hover:text-accent">
            {cluster.headline}
          </p>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {relativeTime(cluster.lastUpdatedAt)}
          </p>
        </div>
      </Link>
    );
  }

  const featured = variant === "featured";

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-shadow hover:shadow-md">
      <Link
        href={`/story/${cluster.slug}`}
        className="absolute inset-0 z-0"
        aria-label={cluster.headline}
      />
      <div
        className={`relative w-full overflow-hidden bg-surface-muted ${featured ? "aspect-[16/9]" : "aspect-[16/10]"}`}
      >
        {cluster.imageUrl ? (
          <Image
            src={cluster.imageUrl}
            alt=""
            fill
            sizes={featured ? "(min-width: 768px) 60vw, 100vw" : "(min-width: 768px) 33vw, 100vw"}
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            unoptimized
          />
        ) : (
          <PlaceholderArt />
        )}
      </div>

      <div className="relative z-10 flex flex-1 flex-col gap-2 p-4 pointer-events-none">
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          {cluster.breaking && <BreakingBadge />}
          {cluster.category && (
            <CategoryBadge slug={cluster.category.slug} name={cluster.category.name} />
          )}
        </div>

        <h3
          className={`font-bold text-foreground group-hover:text-accent ${featured ? "text-2xl leading-tight" : "text-lg leading-snug"} line-clamp-3`}
        >
          {cluster.headline}
        </h3>

        {excerpt && <p className="line-clamp-2 text-sm text-foreground-muted">{excerpt}</p>}

        <div className="mt-auto flex items-center justify-between pt-2 pointer-events-auto">
          <div className="flex items-center gap-3 text-xs text-foreground-muted">
            <span>{relativeTime(cluster.lastUpdatedAt)}</span>
            <span className="flex items-center gap-1">
              {cluster.sourceCount > 1 ? (
                <>
                  <Layers size={13} /> {cluster.sourceCount} sources
                </>
              ) : (
                <>
                  <Newspaper size={13} /> {leadArticle?.source.name}
                </>
              )}
            </span>
          </div>
          <BookmarkButton
            slug={cluster.slug}
            headline={cluster.headline}
            categorySlug={cluster.category?.slug ?? null}
            categoryName={cluster.category?.name ?? null}
            imageUrl={cluster.imageUrl}
          />
        </div>
      </div>
    </article>
  );
}

function PlaceholderArt() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/15 to-surface-muted">
      <Newspaper className="text-foreground-muted opacity-40" size={28} />
    </div>
  );
}
