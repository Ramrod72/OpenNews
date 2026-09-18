import { prisma } from "@/lib/db";
import { SourcesManager } from "./SourcesManager";

export default async function AdminSourcesPage() {
  const [sources, categories] = await Promise.all([
    prisma.source.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { _count: { select: { articles: true } } },
    }),
    prisma.category.findMany({ orderBy: { order: "asc" } }),
  ]);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-extrabold tracking-tight">Sources</h1>
      <p className="mb-6 text-sm text-foreground-muted">
        Add, pause, or remove RSS/Atom feeds. Changes take effect on the next worker tick, or
        immediately via &ldquo;Run ingestion now&rdquo; on the dashboard.
      </p>
      <SourcesManager initialSources={sources} categories={categories} />
    </div>
  );
}
