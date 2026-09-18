"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Bookmark } from "lucide-react";
import { useSavedSearches } from "@/lib/hooks/usePersonalization";
import type { Category } from "@prisma/client";

export function SearchFilters({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { saveSearch } = useSavedSearches();

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  const q = searchParams.get("q") ?? "";

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <select
        value={searchParams.get("category") ?? ""}
        onChange={(e) => update("category", e.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
        aria-label="Filter by category"
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>

      <select
        value={searchParams.get("sort") ?? "relevance"}
        onChange={(e) => update("sort", e.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
        aria-label="Sort results"
      >
        <option value="relevance">Most relevant</option>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </select>

      <label className="flex items-center gap-1.5 text-sm text-foreground-muted">
        From
        <input
          type="date"
          value={searchParams.get("from") ?? ""}
          onChange={(e) => update("from", e.target.value)}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-foreground-muted">
        To
        <input
          type="date"
          value={searchParams.get("to") ?? ""}
          onChange={(e) => update("to", e.target.value)}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
        />
      </label>

      {q && (
        <button
          type="button"
          onClick={() => saveSearch({ label: q, query: searchParams.toString() })}
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-muted"
        >
          <Bookmark size={13} /> Save search
        </button>
      )}
    </div>
  );
}
