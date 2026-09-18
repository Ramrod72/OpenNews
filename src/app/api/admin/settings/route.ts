import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { adSettingsSchema, aiSettingsSchema, DEFAULT_AD_SETTINGS } from "@/lib/validation/settings";

const putSchema = z.object({
  ads: adSettingsSchema.partial().optional(),
  ai: aiSettingsSchema.partial().optional(),
});

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const rows = await prisma.adminSetting.findMany({ where: { key: { in: ["ads", "ai"] } } });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));

  return NextResponse.json({
    ads: { ...DEFAULT_AD_SETTINGS, ...(byKey.ads ?? {}) },
    ai: aiSettingsSchema.parse(byKey.ai ?? {}),
  });
}

export async function PUT(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.ads) {
    await prisma.adminSetting.upsert({
      where: { key: "ads" },
      create: { key: "ads", value: JSON.stringify(parsed.data.ads) },
      update: { value: JSON.stringify(parsed.data.ads) },
    });
  }
  if (parsed.data.ai) {
    await prisma.adminSetting.upsert({
      where: { key: "ai" },
      create: { key: "ai", value: JSON.stringify(parsed.data.ai) },
      update: { value: JSON.stringify(parsed.data.ai) },
    });
  }

  return NextResponse.json({ ok: true });
}
