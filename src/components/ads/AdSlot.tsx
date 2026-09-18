"use client";

import { useEffect, useRef } from "react";

export type AdSlotSize = "leaderboard" | "rectangle" | "in-feed" | "sidebar";

interface AdSlotProps {
  /** Label shown in dev/placeholder state, e.g. "Sidebar" or "Between stories" */
  name: string;
  size?: AdSlotSize;
  enabled: boolean;
  /** Raw ad network HTML/JS snippet, configured by an administrator. */
  code: string;
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
 */
export function AdSlot({ name, size = "rectangle", enabled, code, className }: AdSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled || !code || !containerRef.current) return;
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
  }, [enabled, code]);

  if (!enabled || !code) {
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
