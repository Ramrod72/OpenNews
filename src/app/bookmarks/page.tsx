"use client";

import Link from "next/link";
import Image from "next/image";
import { Bookmark, Newspaper } from "lucide-react";
import { useBookmarks, useSavedSearches } from "@/lib/hooks/usePersonalization";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/format";

export default function BookmarksPage() {
  const { bookmarks, toggleBookmark } = useBookmarks();
  const { saved, removeSearch } = useSavedSearches();

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Bookmarks</h1>
        {bookmarks.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="No bookmarks yet"
            description="Tap the bookmark icon on any story to save it here. Bookmarks are stored only in this browser — no account required."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bookmarks.map((b) => (
              <div key={b.slug} className="flex gap-3 rounded-xl border border-border p-3">
                <Link
                  href={`/story/${b.slug}`}
                  className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-surface-muted"
                >
                  {b.imageUrl ? (
                    <Image
                      src={b.imageUrl}
                      alt=""
                      fill
                      sizes="96px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Newspaper size={18} className="text-foreground-muted opacity-40" />
                    </div>
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/story/${b.slug}`}
                    className="line-clamp-2 text-sm font-semibold hover:text-accent"
                  >
                    {b.headline}
                  </Link>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {b.categoryName} · saved {relativeTime(b.savedAt)}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      toggleBookmark({
                        slug: b.slug,
                        headline: b.headline,
                        categorySlug: b.categorySlug,
                        categoryName: b.categoryName,
                        imageUrl: b.imageUrl,
                      })
                    }
                    className="mt-1 text-xs font-medium text-accent hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-xl font-extrabold tracking-tight">Saved searches</h2>
        {saved.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            Save a search from the search page to quickly re-run it later.
          </p>
        ) : (
          <ul className="space-y-2">
            {saved.map((s) => (
              <li
                key={s.query}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
              >
                <Link href={`/search?${s.query}`} className="text-sm font-medium hover:text-accent">
                  {s.label}
                </Link>
                <button
                  type="button"
                  onClick={() => removeSearch(s.query)}
                  className="text-xs text-foreground-muted hover:text-foreground"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
