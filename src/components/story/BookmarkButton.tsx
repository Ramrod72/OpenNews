"use client";

import { Bookmark } from "lucide-react";
import { useBookmarks } from "@/lib/hooks/usePersonalization";

export function BookmarkButton({
  slug,
  headline,
  categorySlug,
  categoryName,
  imageUrl,
  className,
}: {
  slug: string;
  headline: string;
  categorySlug: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  className?: string;
}) {
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const active = isBookmarked(slug);

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? "Remove bookmark" : "Bookmark this story"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBookmark({ slug, headline, categorySlug, categoryName, imageUrl });
      }}
      className={`flex h-8 w-8 items-center justify-center rounded-full border border-border transition-colors ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "text-foreground-muted hover:text-foreground"
      } ${className ?? ""}`}
    >
      <Bookmark size={15} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
