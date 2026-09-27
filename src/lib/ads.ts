import { prisma } from "@/lib/db";
import { adSettingsSchema, DEFAULT_AD_SETTINGS, type AdSettings } from "@/lib/validation/settings";
import { can } from "@/lib/entitlements";

export async function getAdSettings(): Promise<AdSettings> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key: "ads" } });
    if (!row) return DEFAULT_AD_SETTINGS;
    return adSettingsSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_AD_SETTINGS;
  }
}

/**
 * Whether THIS viewer's plan allows ads at all (the entitlement side of
 * `shouldRenderAd = globalAdsEnabled AND viewerEntitlementAllowsAds`; the
 * admin's global/per-slot toggle from getAdSettings() is the other half,
 * checked separately in AdContainer). Goes through the centralized
 * entitlement system's `can()` — never a hardcoded plan-slug comparison —
 * so anonymous visitors (userId = null) automatically resolve to the Free
 * plan's `ads_enabled` value, same as everywhere else in the app.
 *
 * `checkAdsEnabled` is injectable (defaults to the real `can()`) purely so
 * tests can exercise the failure path below without mocking a module.
 *
 * Fails safely on an unexpected error: an anonymous visitor (userId is
 * `null`, meaning the caller already established there's no session
 * cookie at all — see /api/ads/eligibility) keeps normal Free behavior
 * (ads allowed), since there's no paid promise to protect for a visitor
 * who was never signed in. An authenticated visitor might be a paying
 * subscriber, so any failure resolving their plan fails CLOSED — no ads —
 * rather than risk violating the "Basic/Pro never see ads" guarantee.
 */
export async function resolveViewerAdEligibility(
  userId: string | null,
  checkAdsEnabled: (userId: string | null) => Promise<boolean> = (id) => can(id, "ads_enabled"),
): Promise<boolean> {
  try {
    return await checkAdsEnabled(userId);
  } catch {
    return userId === null;
  }
}
