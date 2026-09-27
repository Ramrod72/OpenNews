"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AdSettings } from "@/lib/validation/settings";

export interface AdConfig {
  /** `null` means "not resolved yet" — see the module doc below. */
  adsAllowed: boolean | null;
  /**
   * The actual ad configuration (every slot's code, the head loader
   * snippet) — present ONLY when `adsAllowed` is `true`. The server never
   * includes it in the response otherwise (see /api/ads/eligibility), so
   * there's nothing here to accidentally render even if a component got
   * this wrong: an ineligible viewer's browser never receives the ad
   * network's snippet/script text over the network in the first place,
   * not just "renders it as hidden."
   */
  settings: AdSettings | null;
}

/**
 * Ad components must treat a pending/`null` `adsAllowed` the same as
 * `false` — not render or inject anything — rather than optimistically
 * showing an ad and possibly having to un-render it a moment later. That
 * asymmetry is deliberate: briefly injecting a third-party ad script
 * before finding out the viewer is a paying subscriber would mean it ran
 * at least once, which is exactly what the Basic/Pro no-ads guarantee
 * rules out. A Free/anonymous viewer just sees their ad slot appear a
 * beat after the rest of the page — a normal, unremarkable delay for
 * lazy-loaded ads.
 */
const AdConfigContext = createContext<AdConfig>({ adsAllowed: null, settings: null });

export function useAdConfig(): AdConfig {
  return useContext(AdConfigContext);
}

/**
 * Fetches this viewer's ad eligibility (and, only if eligible, the actual
 * ad configuration) exactly once per page load, from /api/ads/eligibility
 * — which reads the request's own session cookie — and shares it with
 * every AdSlot/AdHeadSnippet on the page via context, avoiding a separate
 * fetch per ad slot. Mounted once in the root layout.
 */
export function AdEligibilityProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AdConfig>({ adsAllowed: null, settings: null });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/ads/eligibility")
      .then((res) => (res.ok ? res.json() : { adsAllowed: false }))
      .then((data: { adsAllowed?: unknown; settings?: AdSettings }) => {
        if (cancelled) return;
        if (data.adsAllowed === true && data.settings) {
          setConfig({ adsAllowed: true, settings: data.settings });
        } else {
          setConfig({ adsAllowed: false, settings: null });
        }
      })
      .catch(() => {
        // Same fail-closed default as the endpoint itself uses for an
        // authenticated-but-unresolvable viewer — a network failure here
        // is indistinguishable from that case as far as this client can tell.
        if (!cancelled) setConfig({ adsAllowed: false, settings: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <AdConfigContext.Provider value={config}>{children}</AdConfigContext.Provider>;
}
