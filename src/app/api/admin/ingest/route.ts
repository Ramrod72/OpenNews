import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guard";
import { ingestAllDueSources } from "@/lib/ingest/ingestAll";
import { ingestSource } from "@/lib/ingest/ingestSource";
import { clusterRecentArticles } from "@/lib/clustering/cluster";
import { prisma } from "@/lib/db";
import { logAdminAction } from "@/lib/adminAudit";

const bodySchema = z.object({ sourceId: z.string().optional(), force: z.boolean().optional() });

/**
 * Triggers an immediate ingestion run from the admin panel. Runs
 * synchronously and returns a summary — self-hosted deployments run this
 * on a long-lived Node process (not a serverless function), so there's no
 * request-timeout concern for a modest number of feeds.
 */
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.sourceId) {
    const source = await prisma.source.findUnique({ where: { id: parsed.data.sourceId } });
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    const result = await ingestSource(source);
    await clusterRecentArticles();
    await logAdminAction(prisma, {
      action: "ingest.trigger",
      targetType: "Source",
      targetId: source.id,
      summary: "triggered manual ingestion for one source",
    });
    return NextResponse.json({ results: [result] });
  }

  const results = await ingestAllDueSources({ force: parsed.data.force ?? true });
  const clusterResult = await clusterRecentArticles();
  await logAdminAction(prisma, {
    action: "ingest.trigger",
    summary: `triggered manual ingestion (${results.length} sources)`,
  });
  return NextResponse.json({ results, clusterResult });
}
