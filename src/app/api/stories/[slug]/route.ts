import { NextResponse } from "next/server";
import { getStoryClusterBySlug } from "@/lib/stories";
import { serializeCluster } from "@/lib/serialize";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

// See src/app/api/search/route.ts's own comment for why this route gets a
// tighter, dedicated limiter on top of the general 120/min-per-IP one
// already applied to every /api/* route in src/proxy.ts.
const PUBLIC_READ_LIMIT = 60;
const PUBLIC_READ_WINDOW_MS = 60_000;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ip = clientIp(req);
  if (isRateLimited(`public-read:story:${ip}`, PUBLIC_READ_LIMIT, PUBLIC_READ_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { slug } = await params;
  const cluster = await getStoryClusterBySlug(slug);
  if (!cluster) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }
  return NextResponse.json({ story: serializeCluster(cluster) });
}
