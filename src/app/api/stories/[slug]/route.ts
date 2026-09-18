import { NextResponse } from "next/server";
import { getStoryClusterBySlug } from "@/lib/stories";
import { serializeCluster } from "@/lib/serialize";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cluster = await getStoryClusterBySlug(slug);
  if (!cluster) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }
  return NextResponse.json({ story: serializeCluster(cluster) });
}
