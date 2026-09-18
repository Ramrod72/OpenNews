import { prisma } from "@/lib/db";
import { adSettingsSchema, DEFAULT_AD_SETTINGS, type AdSettings } from "@/lib/validation/settings";

export async function getAdSettings(): Promise<AdSettings> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key: "ads" } });
    if (!row) return DEFAULT_AD_SETTINGS;
    return adSettingsSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_AD_SETTINGS;
  }
}
