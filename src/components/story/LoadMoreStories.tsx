"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { StoryCard, type StoryCardData } from "./StoryCard";

export function LoadMoreStories({
  initialCursor,
  query,
}: {
  initialCursor: string | null;
  query: Record<string, string | undefined>;
}) {
  const [stories, setStories] = useState<StoryCardData[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][],
      );
      params.set("cursor", cursor);
      const res = await fetch(`/api/stories?${params.toString()}`);
      const data = (await res.json()) as { stories: StoryCardData[]; nextCursor: string | null };
      setStories((prev) => [...prev, ...data.stories]);
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {stories.length > 0 && (
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {stories.map((cluster) => (
            <StoryCard key={cluster.id} cluster={cluster} />
          ))}
        </div>
      )}
      {cursor && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="flex items-center gap-2 rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
