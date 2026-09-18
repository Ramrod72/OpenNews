"use client";

import { useEffect } from "react";

/** Mounts an admin-configured ad network loader script (e.g. an AdSense head tag) once, site-wide. */
export function AdHeadSnippet({ enabled, snippet }: { enabled: boolean; snippet: string }) {
  useEffect(() => {
    if (!enabled || !snippet.trim()) return;

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
  }, [enabled, snippet]);

  return null;
}
