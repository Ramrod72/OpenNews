"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Link2, Share2 } from "lucide-react";
import {
  buildFacebookShareUrl,
  buildLinkedInShareUrl,
  buildRedditShareUrl,
  buildWhatsAppShareUrl,
  buildXShareUrl,
} from "@/lib/share";
import { copyStoryLink, shareViaNativeShare } from "@/lib/shareActions";

/**
 * Shares the Veriqen story page itself — `url` must always be the
 * canonical Veriqen story URL (see src/lib/share.ts's getStoryUrl),
 * never a publisher/article URL. Callers pass it in rather than this
 * component computing one, so there's a single source of truth shared
 * with the page's own Open Graph/Twitter metadata.
 */
function subscribeNoop() {
  return () => {};
}

function getCanNativeShare() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

function getCanNativeShareServer() {
  return false;
}

export function ShareButton({ url, title }: { url: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const containerRef = useRef<HTMLDivElement>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // navigator.share support differs between the server (never available)
  // and the client, and there's nothing to actually subscribe to — this is
  // the standard way to read a value like that without a hydration
  // mismatch (server/first-hydration render use getCanNativeShareServer,
  // then React re-renders with the real client value right after).
  const canNativeShare = useSyncExternalStore(
    subscribeNoop,
    getCanNativeShare,
    getCanNativeShareServer,
  );

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, []);

  async function handleCopy() {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    const result = await copyStoryLink(url, clipboard);
    setCopyState(result.ok ? "copied" : "failed");
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  async function handleNativeShare() {
    const nativeShare =
      typeof navigator !== "undefined" && typeof navigator.share === "function"
        ? navigator
        : undefined;
    // Cancellation and "unsupported" both resolve quietly — neither is an
    // error worth surfacing to the user.
    await shareViaNativeShare({ title, url }, nativeShare);
    setOpen(false);
  }

  const destinations = [
    { label: "X", href: buildXShareUrl({ url, title }) },
    { label: "Facebook", href: buildFacebookShareUrl({ url }) },
    { label: "Reddit", href: buildRedditShareUrl({ url, title }) },
    { label: "LinkedIn", href: buildLinkedInShareUrl({ url }) },
    { label: "WhatsApp", href: buildWhatsAppShareUrl({ url, title }) },
  ];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Share this story"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted"
      >
        <Share2 size={14} /> Share
      </button>

      <span role="status" aria-live="polite" className="sr-only">
        {copyState === "copied" && "Link copied"}
        {copyState === "failed" && "Couldn't copy the link"}
      </span>

      {open && (
        <div
          role="menu"
          aria-label="Share this story"
          className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-muted"
          >
            {copyState === "copied" ? <Check size={15} /> : <Link2 size={15} />}
            {copyState === "copied"
              ? "Copied!"
              : copyState === "failed"
                ? "Couldn't copy — copy manually"
                : "Copy link"}
          </button>

          {canNativeShare && (
            <button
              type="button"
              role="menuitem"
              onClick={handleNativeShare}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-muted"
            >
              <Share2 size={15} /> Share via…
            </button>
          )}

          <div className="my-1 border-t border-border" />

          {destinations.map((d) => (
            <a
              key={d.label}
              role="menuitem"
              href={d.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-muted"
            >
              {d.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
