import Link from "next/link";
import { SearchX } from "lucide-react";
import { searchStories } from "@/lib/search";
import { listCategories } from "@/lib/stories";
import { StoryCard } from "@/components/story/StoryCard";
import { SearchFilters } from "@/components/story/SearchFilters";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Search" };

interface SearchPageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const [result, categories] = await Promise.all([
    searchStories({
      q: params.q,
      categorySlug: params.category,
      sourceId: params.source,
      sort: params.sort === "newest" || params.sort === "oldest" ? params.sort : "relevance",
      dateFrom: params.from,
      dateTo: params.to,
      page: Number(params.page) || 1,
    }),
    listCategories(),
  ]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-extrabold tracking-tight">
        {params.q ? `Results for “${params.q}”` : "Search"}
      </h1>
      <p className="mb-6 text-sm text-foreground-muted">
        {result.total} {result.total === 1 ? "story" : "stories"} found
      </p>

      <SearchFilters categories={categories} />

      {result.results.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matching stories"
          description="Try a different keyword, or widen your date range and filters."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {result.results.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>

          {result.totalPages > 1 && (
            <nav
              className="mt-8 flex items-center justify-center gap-2"
              aria-label="Search results pages"
            >
              {Array.from({ length: result.totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/search?${new URLSearchParams({ ...params, page: String(p) } as Record<string, string>).toString()}`}
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm ${
                    p === result.page
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-surface-muted"
                  }`}
                >
                  {p}
                </Link>
              ))}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
