"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  APPEARANCE_LABELS,
  APPEARANCE_VALUES,
  isValidAppearancePreference,
  type AppearancePreference,
} from "@/lib/appearance";

const APPEARANCE_ICONS: Record<AppearancePreference, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

function subscribeNoop() {
  return () => {};
}

// The persisted preference isn't known during SSR/first paint — reading it
// only after mount (via useSyncExternalStore's client/server snapshot
// split, not a setState-in-effect) keeps the server-rendered markup and
// the first client render identical, avoiding a hydration mismatch. Until
// then the trigger shows the System icon, matching the documented default.
function getServerPreference(): AppearancePreference {
  return "system";
}

/**
 * Compact header control: a single icon button that opens a small popover
 * with all three appearance options (System/Light/Dark), so a visitor can
 * always get back to "follow my device" after picking an explicit theme —
 * not just a light/dark toggle. Reads and writes the exact same
 * next-themes preference as the Account → Appearance section
 * (AppearanceSection.tsx); neither one owns the value.
 */
export function AppearanceMenu() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const clientPreference: AppearancePreference = isValidAppearancePreference(theme)
    ? theme
    : "system";
  const preference = useSyncExternalStore(
    subscribeNoop,
    () => clientPreference,
    getServerPreference,
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

  const TriggerIcon = APPEARANCE_ICONS[preference];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Appearance: ${APPEARANCE_LABELS[preference]}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-muted hover:text-foreground"
      >
        <TriggerIcon size={16} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Choose appearance"
          className="absolute right-0 z-20 mt-2 w-44 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
        >
          {APPEARANCE_VALUES.map((value) => {
            const Icon = APPEARANCE_ICONS[value];
            const active = value === preference;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-muted"
              >
                <Icon size={15} />
                <span className="flex-1">{APPEARANCE_LABELS[value]}</span>
                {active && <Check size={15} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
