import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  homepageUrl: z.string().url().optional().or(z.literal("")).optional(),
  categorySlug: z.string().min(1).optional(),
  fetchIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.categorySlug) {
    const category = await prisma.category.findUnique({
      where: { slug: parsed.data.categorySlug },
    });
    if (!category) return NextResponse.json({ error: "Unknown category slug" }, { status: 400 });
  }

  try {
    const source = await prisma.source.update({
      where: { id },
      data: {
        ...parsed.data,
        homepageUrl: parsed.data.homepageUrl === "" ? null : parsed.data.homepageUrl,
      },
    });
    return NextResponse.json({ source });
  } catch {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    await prisma.source.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
}
