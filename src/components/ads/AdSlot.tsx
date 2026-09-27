"use client";

import { useEffect, useRef } from "react";
import { useAdConfig } from "./AdEligibilityProvider";
import { shouldRenderAds } from "./shouldRenderAds";

export type AdSlotSize = "leaderboard" | "rectangle" | "in-feed" | "sidebar";
export type AdSlotKey =
  "homepageFeed" | "sidebar" | "betweenStories" | "articlePage" | "mobileFeed";

interface AdSlotProps {
  /** Label shown in dev/placeholder state, e.g. "Sidebar" or "Between stories" */
  name: string;
  size?: AdSlotSize;
  slot: AdSlotKey;
  className?: string;
}

const SIZE_CLASSES: Record<AdSlotSize, string> = {
  leaderboard: "min-h-[90px]",
  rectangle: "min-h-[250px]",
  "in-feed": "min-h-[120px]",
  sidebar: "min-h-[250px]",
};

/**
 * Generic, provider-agnostic ad placement. With no code configured it
 * renders a clearly-labeled placeholder so the layout reads correctly and
 * it's obvious to both visitors and the site operator that nothing fake is
 * being presented as an ad. Once an administrator pastes a network's
 * snippet into Admin → Advertising, this mounts it for real — including
 * re-creating any <script> tags so they actually execute (setting HTML via
 * innerHTML does not run embedded scripts).
 *
 * The admin's global/per-slot toggle AND the actual ad code both come
 * from useAdConfig() (Phase 5) — never as props from a server component,
 * and never present at all unless this viewer's plan allows ads. That's
 * deliberate: AdContainer sits inside pages that use ISR caching, so it
 * can't know the viewer per-request without leaking one visitor's ad
 * state into the shared cache (see ARCHITECTURE.md). A Basic/Pro viewer
 * gets no ad-shaped UI at all — not just a hidden one, and not merely an
 * un-executed one: the ad network's snippet/script text is never even
 * sent to their browser in the first place.
 */
export function AdSlot({ name, size = "rectangle", slot, className }: AdSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { adsAllowed, settings } = useAdConfig();
  const slotConfig = settings?.slots[slot];
  const code = slotConfig?.code ?? "";
  const active = shouldRenderAds(
    adsAllowed,
    Boolean(settings?.enabled),
    Boolean(slotConfig?.enabled),
  );

  useEffect(() => {
    if (!active || !code || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";

    const template = document.createElement("template");
    template.innerHTML = code.trim();

    template.content.childNodes.forEach((node) => {
      if (node.nodeName === "SCRIPT") {
        const original = node as HTMLScriptElement;
        const script = document.createElement("script");
        for (const attr of Array.from(original.attributes)) {
          script.setAttribute(attr.name, attr.value);
        }
        script.text = original.text;
        container.appendChild(script);
      } else {
        container.appendChild(node.cloneNode(true));
      }
    });

    return () => {
      container.innerHTML = "";
    };
  }, [active, code]);

  if (!active) return null;

  if (!code) {
    return (
      <div
        role="complementary"
        aria-label={`Advertisement placeholder: ${name}`}
        className={`flex ${SIZE_CLASSES[size]} w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-surface-muted text-foreground-muted ${className ?? ""}`}
      >
        <span className="text-[10px] font-semibold tracking-widest uppercase opacity-60">
          Advertisement
        </span>
        <span className="text-xs opacity-40">{name}</span>
      </div>
    );
  }

  return (
    <div className={`w-full ${className ?? ""}`}>
      <span className="mb-1 block text-[10px] font-semibold tracking-widest text-foreground-muted uppercase opacity-60">
        Advertisement
      </span>
      <div ref={containerRef} className={SIZE_CLASSES[size]} />
    </div>
  );
}
