import Link from "next/link";
import type { Metadata } from "next";
import { listActiveSources, listCategories } from "@/lib/stories";
import { getSiteUrl } from "@/lib/siteUrl";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd, buildCollectionPageJsonLd } from "@/lib/seo/structuredData";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";

const DESCRIPTION =
  "The publicly published RSS/Atom feeds Veriqen News aggregates, grouped by section, each linking to its own source profile.";

export const metadata: Metadata = {
  title: "Sources",
  description: DESCRIPTION,
  alternates: { canonical: `${getSiteUrl()}/sources` },
};
export const revalidate = 300;

export default async function SourcesPage() {
  const [sources, categories] = await Promise.all([listActiveSources(), listCategories()]);
  const categoryName = new Map(categories.map((c) => [c.slug, c.name]));

  const bySection = new Map<string, typeof sources>();
  for (const source of sources) {
    const key = source.categorySlug;
    bySection.set(key, [...(bySection.get(key) ?? []), source]);
  }

  const siteUrl = getSiteUrl();
  const pageUrl = `${siteUrl}/sources`;

  return (
    <div>
      <JsonLd
        data={buildCollectionPageJsonLd({
          name: "Sources",
          description: DESCRIPTION,
          url: pageUrl,
          siteUrl,
          items: sources.map((s) => ({ name: s.name, url: `${siteUrl}/sources/${s.id}` })),
        })}
      />
      <JsonLd
        data={buildBreadcrumbListJsonLd([
          { name: "Home", url: siteUrl },
          { name: "Sources", url: pageUrl },
        ])}
      />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Sources" }]} />

      <h1 className="mb-2 text-2xl font-extrabold tracking-tight">Sources</h1>
      <p className="mb-8 max-w-2xl text-sm text-foreground-muted">
        Veriqen News aggregates headlines from the publicly published RSS/Atom feeds below. It links
        back to each original article and never republishes full article content. See the
        project&apos;s{" "}
        <code className="rounded bg-surface-muted px-1 py-0.5 text-xs">config/sources.json</code> to
        add or remove feeds on a self-hosted instance.
      </p>

      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        {Array.from(bySection.entries()).map(([slug, list]) => (
          <div key={slug}>
            <h2 className="mb-2 font-bold">{categoryName.get(slug) ?? slug}</h2>
            <ul className="space-y-1.5 text-sm">
              {list.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3">
                  <Link href={`/sources/${s.id}`} className="hover:text-accent hover:underline">
                    {s.name}
                  </Link>
                  {s.homepageUrl && (
                    <a
                      href={s.homepageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-xs text-foreground-muted hover:text-accent hover:underline"
                    >
                      Visit site
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
