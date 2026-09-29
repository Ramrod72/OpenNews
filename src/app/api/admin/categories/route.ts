import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { logAdminAction } from "@/lib/adminAudit";

const updateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  order: z.number().int().optional(),
});

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const categories = await prisma.category.findMany({
    orderBy: { order: "asc" },
    include: { _count: { select: { articles: true, clusters: true } } },
  });
  return NextResponse.json({ categories });
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { id, ...data } = parsed.data;
  try {
    const category = await prisma.category.update({ where: { id }, data });
    await logAdminAction(prisma, {
      action: "category.update",
      targetType: "Category",
      targetId: category.id,
      summary: "updated category",
    });
    return NextResponse.json({ category });
  } catch {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
}
