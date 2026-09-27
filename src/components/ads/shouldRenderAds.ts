/**
 * shouldRenderAd = globalAdsEnabled AND viewerEntitlementAllowsAds AND
 * (for a per-slot placement) that specific slot's admin toggle.
 *
 * `adsAllowed` is `null` while the client-side eligibility check
 * (AdEligibilityProvider) hasn't resolved yet, and is deliberately treated
 * the same as `false` here — nothing renders (not even the placeholder)
 * until eligibility is confirmed. `globalEnabled`/`slotEnabled` only ever
 * have a real value to check once `adsAllowed` is `true`, since the ad
 * configuration itself is only ever sent to the browser once eligibility
 * is confirmed (see /api/ads/eligibility) — so this still fails closed
 * even if called with stale/default values before that.
 */
export function shouldRenderAds(
  adsAllowed: boolean | null,
  globalEnabled: boolean,
  slotEnabled: boolean,
): boolean {
  return adsAllowed === true && globalEnabled && slotEnabled;
}
