import { listActiveSources, listCategories } from "@/lib/stories";

export const metadata = { title: "Sources" };
export const revalidate = 300;

export default async function SourcesPage() {
  const [sources, categories] = await Promise.all([listActiveSources(), listCategories()]);
  const categoryName = new Map(categories.map((c) => [c.slug, c.name]));

  const bySection = new Map<string, typeof sources>();
  for (const source of sources) {
    const key = source.categorySlug;
    bySection.set(key, [...(bySection.get(key) ?? []), source]);
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-extrabold tracking-tight">Sources</h1>
      <p className="mb-8 max-w-2xl text-sm text-foreground-muted">
        OpenNews aggregates headlines from the publicly published RSS/Atom feeds below. It links
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
                <li key={s.id}>
                  {s.homepageUrl ? (
                    <a
                      href={s.homepageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-accent hover:underline"
                    >
                      {s.name}
                    </a>
                  ) : (
                    s.name
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
