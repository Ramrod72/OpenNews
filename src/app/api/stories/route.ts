import { NextResponse } from "next/server";
import { listStoryClusters } from "@/lib/stories";
import { serializeCluster } from "@/lib/serialize";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

// See src/app/api/search/route.ts's own comment for why this route gets a
// tighter, dedicated limiter on top of the general 120/min-per-IP one
// already applied to every /api/* route in src/proxy.ts.
const PUBLIC_READ_LIMIT = 60;
const PUBLIC_READ_WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const ip = clientIp(req);
  if (isRateLimited(`public-read:stories:${ip}`, PUBLIC_READ_LIMIT, PUBLIC_READ_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

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
