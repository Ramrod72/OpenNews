import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { listStoryClustersByPage } from "@/lib/stories";
import { getSiteUrl } from "@/lib/siteUrl";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd, buildCollectionPageJsonLd } from "@/lib/seo/structuredData";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { StoryCard } from "@/components/story/StoryCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { AdContainer } from "@/components/ads/AdContainer";

export const revalidate = 60;

const PAGE_SIZE = 12;

interface CategoryPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export async function generateMetadata({
  params,
  searchParams,
}: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const { page: rawPage } = await searchParams;
  const category = await prisma.category.findUnique({ where: { slug } });
  if (!category) return { title: "Category" };

  const page = parsePage(rawPage);
  const siteUrl = getSiteUrl();
  // Page 1 canonicalizes to the bare URL; page N>1 canonicalizes to
  // itself — each page is genuinely different content, so none of them
  // ever collapses onto page 1 or the homepage (see this project's own
  // SEO audit notes in ARCHITECTURE.md).
  const canonical =
    page > 1 ? `${siteUrl}/category/${slug}?page=${page}` : `${siteUrl}/category/${slug}`;

  return {
    title: page > 1 ? `${category.name} — Page ${page}` : category.name,
    description: `The latest ${category.name} stories Veriqen News has clustered from publicly published RSS/Atom feeds.`,
    alternates: { canonical },
  };
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params;
  const { page: rawPage } = await searchParams;
  const category = await prisma.category.findUnique({ where: { slug } });
  if (!category) notFound();

  const page = parsePage(rawPage);
  const { clusters, totalPages } = await listStoryClustersByPage({
    categorySlug: slug,
    page,
    pageSize: PAGE_SIZE,
  });
  // An out-of-range page number (e.g. requesting page 50 of a 3-page
  // category) is a genuine 404, not an empty page — otherwise every
  // integer beyond totalPages would become a distinct, indexable,
  // permanently-empty URL, which is exactly the "infinite crawl space"
  // this feature must avoid.
  if (page > 1 && page > totalPages) notFound();

  const siteUrl = getSiteUrl();
  const basePath = `/category/${slug}`;
  const pageUrl = page > 1 ? `${siteUrl}${basePath}?page=${page}` : `${siteUrl}${basePath}`;

  return (
    <div>
      <JsonLd
        data={buildCollectionPageJsonLd({
          name: category.name,
          url: pageUrl,
          siteUrl,
          items: clusters.map((c) => ({
            name: c.headline,
            url: `${siteUrl}/story/${encodeURIComponent(c.slug)}`,
          })),
        })}
      />
      <JsonLd
        data={buildBreadcrumbListJsonLd([
          { name: "Home", url: siteUrl },
          { name: category.name, url: `${siteUrl}${basePath}` },
        ])}
      />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: category.name }]} />

      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">{category.name}</h1>

      {clusters.length === 0 ? (
        <EmptyState
          title="No stories in this category yet"
          description="Once the ingestion worker runs against the configured feeds, stories will appear here."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {clusters.map((cluster) => (
              <StoryCard key={cluster.id} cluster={cluster} />
            ))}
          </div>

          {totalPages > 1 && (
            <CategoryPagination basePath={basePath} page={page} totalPages={totalPages} />
          )}
        </>
      )}

      <div className="mt-8">
        <AdContainer slot="betweenStories" />
      </div>
    </div>
  );
}

/**
 * Plain, deterministic `?page=N` links — real <Link>s a crawler can
 * follow to every page without any client-side fetch, unlike the
 * previous client-only "Load more" button. Bounded by the real
 * `totalPages` computed from the category's actual row count, never an
 * unbounded/fabricated range.
 */
function CategoryPagination({
  basePath,
  page,
  totalPages,
}: {
  basePath: string;
  page: number;
  totalPages: number;
}) {
  return (
    <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Category pages">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
        <Link
          key={p}
          href={p === 1 ? basePath : `${basePath}?page=${p}`}
          aria-current={p === page ? "page" : undefined}
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm ${
            p === page ? "bg-accent text-accent-foreground" : "hover:bg-surface-muted"
          }`}
        >
          {p}
        </Link>
      ))}
    </nav>
  );
}
