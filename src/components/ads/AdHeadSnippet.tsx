"use client";

import { useEffect } from "react";
import { useAdConfig } from "./AdEligibilityProvider";
import { shouldRenderAds } from "./shouldRenderAds";

/**
 * Mounts an admin-configured ad network loader script (e.g. an AdSense
 * head tag) once, site-wide — but only for viewers whose plan allows ads
 * at all (Phase 5), and takes no props: the snippet text itself comes
 * from useAdConfig(), which never carries it at all unless this viewer is
 * eligible (see /api/ads/eligibility). Without this, a paid viewer's
 * browser would still have received (and, before this fix, executed) the
 * ad network's own loader script globally, even though AdSlot showed them
 * nothing — defeating the "no ads" guarantee for anything that script
 * does on its own (tracking pixels, auto-inserted units, etc.).
 */
export function AdHeadSnippet() {
  const { adsAllowed, settings } = useAdConfig();
  const snippet = settings?.headSnippet ?? "";
  const active = shouldRenderAds(adsAllowed, Boolean(settings?.enabled), true);

  useEffect(() => {
    if (!active || !snippet.trim()) return;

    const template = document.createElement("template");
    template.innerHTML = snippet.trim();
    const inserted: Node[] = [];

    template.content.childNodes.forEach((node) => {
      if (node.nodeName === "SCRIPT") {
        const original = node as HTMLScriptElement;
        const script = document.createElement("script");
        for (const attr of Array.from(original.attributes)) {
          script.setAttribute(attr.name, attr.value);
        }
        script.text = original.text;
        document.head.appendChild(script);
        inserted.push(script);
      } else {
        const clone = node.cloneNode(true);
        document.head.appendChild(clone);
        inserted.push(clone);
      }
    });

    return () => {
      inserted.forEach((node) => node.parentNode?.removeChild(node));
    };
  }, [active, snippet]);

  return null;
}
