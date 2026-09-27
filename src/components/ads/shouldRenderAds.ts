/**
 * shouldRenderAd = globalAdsEnabled AND viewerEntitlementAllowsAds
 *
 * `viewerAllowsAds` is `null` while the client-side eligibility check
 * (AdEligibilityProvider) hasn't resolved yet, and is deliberately treated
 * the same as `false` here — nothing renders (not even the placeholder)
 * until eligibility is confirmed. Kept in its own zero-dependency module,
 * separate from AdSlot/AdHeadSnippet, so both consume the exact same
 * decision and it's directly unit-testable without a DOM.
 */
export function shouldRenderAds(globalEnabled: boolean, viewerAllowsAds: boolean | null): boolean {
  return globalEnabled && viewerAllowsAds === true;
}
