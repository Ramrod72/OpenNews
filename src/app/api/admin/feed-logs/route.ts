import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const sourceId = searchParams.get("source") ?? undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 300);

  const logs = await prisma.feedFetchLog.findMany({
    where: sourceId ? { sourceId } : undefined,
    include: { source: { select: { name: true } } },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ logs });
}
