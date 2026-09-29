import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { adSettingsSchema, aiSettingsSchema, DEFAULT_AD_SETTINGS } from "@/lib/validation/settings";
import { logAdminAction } from "@/lib/adminAudit";
import { getAiConfig } from "@/lib/ai/config";

const putSchema = z.object({
  ads: adSettingsSchema.partial().optional(),
  ai: aiSettingsSchema.partial().optional(),
});

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const rows = await prisma.adminSetting.findMany({ where: { key: "ads" } });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));

  // The "ai" key uses getAiConfig() (the SAME env+AdminSetting merge every
  // other caller uses — see that function's own doc comment) rather than
  // a bare schema parse of the stored row alone. This matters: the form
  // round-trips whatever this GET returns back through PUT below, so if
  // this ever returned just the raw stored (possibly-empty) row, saving
  // unrelated ad settings would silently persist a stale/default value
  // that then PERMANENTLY overrides an env-configured default (e.g.
  // AI_STORY_BRIEF_ENABLED=true) the next time getAiConfig() runs.
  // Returning the true current effective value closes that gap. Only
  // the fields intentionally admin-editable are ever picked —
  // storyBriefTimeoutMs is deliberately never exposed here (Phase 13A/B
  // scope decision).
  const aiConfig = await getAiConfig();

  return NextResponse.json({
    ads: { ...DEFAULT_AD_SETTINGS, ...(byKey.ads ?? {}) },
    ai: {
      provider: aiConfig.provider,
      baseUrl: aiConfig.baseUrl,
      model: aiConfig.model,
      storyBriefEnabled: aiConfig.storyBriefEnabled,
    } satisfies z.infer<typeof aiSettingsSchema>,
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
    await logAdminAction(prisma, {
      action: "settings.update.ads",
      targetType: "AdminSetting",
      targetId: "ads",
      summary: "updated ad settings",
    });
  }
  if (parsed.data.ai) {
    await prisma.adminSetting.upsert({
      where: { key: "ai" },
      create: { key: "ai", value: JSON.stringify(parsed.data.ai) },
      update: { value: JSON.stringify(parsed.data.ai) },
    });
    await logAdminAction(prisma, {
      action: "settings.update.ai",
      targetType: "AdminSetting",
      targetId: "ai",
      summary: "updated AI settings",
    });
  }

  return NextResponse.json({ ok: true });
}
