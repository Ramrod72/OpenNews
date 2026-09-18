import { NextResponse } from "next/server";
import { searchStories } from "@/lib/search";
import { serializeCluster } from "@/lib/serialize";

export async function GET(req: Request) {
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
