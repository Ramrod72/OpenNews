import { NextResponse } from "next/server";
import { searchStories } from "@/lib/search";
import { serializeCluster } from "@/lib/serialize";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

// Tighter than the general 120/min-per-IP API limiter (src/proxy.ts,
// applied to every /api/* route already): this specific route runs a
// multi-join query plus in-memory relevance scoring over up to 800
// candidate rows per request (see src/lib/search.ts's CANDIDATE_LIMIT),
// the most expensive public, unauthenticated read in the app. Bounded,
// in-memory, per-process — see src/lib/rateLimit.ts's own doc comment.
const PUBLIC_READ_LIMIT = 60;
const PUBLIC_READ_WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const ip = clientIp(req);
  if (isRateLimited(`public-read:search:${ip}`, PUBLIC_READ_LIMIT, PUBLIC_READ_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const sortParam = searchParams.get("sort");

  const result = await searchStories({
    q: searchParams.get("q") ?? undefined,
    categorySlug: searchParams.get("category") ?? undefined,
    sourceId: searchParams.get("source") ?? undefined,
    sort: sortParam === "newest" || sortParam === "oldest" ? sortParam : "relevance",
    dateFrom: searchParams.get("from") ?? undefined,
    dateTo: searchParams.get("to") ?? undefined,
    page: Number(searchParams.get("page")) || 1,
  });

  return NextResponse.json({
    results: result.results.map(serializeCluster),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
  });
}
