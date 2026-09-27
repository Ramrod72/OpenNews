"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * `null` means "not resolved yet" — ad components must treat this the
 * same as `false` (don't render/inject anything) rather than optimistically
 * showing an ad and possibly having to un-render it a moment later. That
 * asymmetry is deliberate: briefly injecting a third-party ad script before
 * finding out the viewer is a paying subscriber would mean it ran at least
 * once, which is exactly what the Basic/Pro no-ads guarantee rules out.
 * A Free/anonymous viewer just sees their ad slot appear a beat after the
 * rest of the page — a normal, unremarkable delay for lazy-loaded ads.
 */
const AdEligibilityContext = createContext<boolean | null>(null);

export function useAdEligibility(): boolean | null {
  return useContext(AdEligibilityContext);
}

/**
 * Fetches this viewer's ad eligibility exactly once per page load (from
 * /api/ads/eligibility, which reads the request's own session cookie) and
 * shares it with every AdSlot/AdHeadSnippet on the page via context —
 * avoiding a separate fetch per ad slot. Mounted once in the root layout.
 */
export function AdEligibilityProvider({ children }: { children: ReactNode }) {
  const [adsAllowed, setAdsAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/ads/eligibility")
      .then((res) => (res.ok ? res.json() : { adsAllowed: false }))
      .then((data: { adsAllowed?: unknown }) => {
        if (!cancelled) setAdsAllowed(data.adsAllowed === true);
      })
      .catch(() => {
        // Same fail-closed default as the endpoint itself uses for an
        // authenticated-but-unresolvable viewer — a network failure here
        // is indistinguishable from that case as far as this client can tell.
        if (!cancelled) setAdsAllowed(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AdEligibilityContext.Provider value={adsAllowed}>{children}</AdEligibilityContext.Provider>
  );
}
