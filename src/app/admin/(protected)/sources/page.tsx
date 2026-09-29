import { prisma } from "@/lib/db";
import { SourcesManager } from "./SourcesManager";

// Every /admin/(protected) page reads live operational data and must
// never be statically prerendered at build time (Next's default
// optimization for a Server Component with no dynamic API call in its
// own render path — auth here comes from middleware, not cookies()/
// headers() inside the page itself, so nothing else forces dynamic
// rendering). Discovered during Phase 13B's adversarial review: without
// this, a `next build && next start` deployment would freeze every
// admin page's data at build time. See ARCHITECTURE.md's Phase 13
// section.
export const dynamic = "force-dynamic";

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
