import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { SourceProfileManager } from "./SourceProfileManager";

// Admin auth here comes from middleware (src/proxy.ts), not cookies()/
// headers() inside the page itself, so nothing else forces this page to
// render dynamically per request -- without this, Next's default static
// optimization would prerender it once at build time and keep serving
// that same snapshot after an admin edits the source, exactly the bug
// class Phase 13 fixed on every OTHER protected admin page (see
// ARCHITECTURE.md's "Known limitations"). This page reads live data
// (source + externalAssessments) so it needs the same fix.
export const dynamic = "force-dynamic";

export default async function AdminSourceProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const source = await prisma.source.findUnique({
    where: { id },
    include: {
      externalAssessments: { orderBy: [{ assessmentType: "asc" }, { provider: "asc" }] },
    },
  });
  if (!source) notFound();

  return (
    <div>
      <Link
        href="/admin/sources"
        className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back to sources
      </Link>
      <h1 className="mb-1 text-2xl font-extrabold tracking-tight">{source.name}</h1>
      <p className="mb-6 text-sm text-foreground-muted">
        Publisher profile metadata and externally attributed assessments. All fields are optional —
        a source with none of this filled in still works normally for ingestion.
      </p>
      <SourceProfileManager source={source} />
    </div>
  );
}
