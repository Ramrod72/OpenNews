import { NextResponse } from "next/server";
import { listStoryClusters } from "@/lib/stories";
import { serializeCluster } from "@/lib/serialize";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const { clusters, nextCursor } = await listStoryClusters({
    categorySlug: searchParams.get("category") ?? undefined,
    breakingOnly: searchParams.get("breaking") === "true",
    sourceId: searchParams.get("source") ?? undefined,
    sort: searchParams.get("sort") === "oldest" ? "oldest" : "latest",
    limit: Number(searchParams.get("limit")) || undefined,
    cursor: searchParams.get("cursor") ?? undefined,
  });

  return NextResponse.json({
    stories: clusters.map(serializeCluster),
    nextCursor,
  });
}
