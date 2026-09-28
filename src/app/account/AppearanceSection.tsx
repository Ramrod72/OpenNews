"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  APPEARANCE_DESCRIPTIONS,
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

function getServerPreference(): AppearancePreference {
  return "system";
}

/**
 * The primary appearance control (Account → Appearance). Reads and writes
 * the exact same next-themes preference as the header's compact
 * AppearanceMenu — this component doesn't own the value, it's just a
 * second, more spacious view onto it, so a change here is reflected in
 * the header immediately and vice versa.
 *
 * Client-only and rendered from the (server) account page the same way
 * LogoutButton already is — no account data is needed for this control,
 * so it works identically for anonymous visitors wherever it's rendered;
 * it just happens to live on an auth-gated page here per the brief.
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  const clientPreference: AppearancePreference = isValidAppearancePreference(theme)
    ? theme
    : "system";
  // Avoids a hydration mismatch the same way AppearanceMenu/ShareButton do:
  // the server (and first client render) always reports "system" since
  // the real persisted value isn't known until after mount.
  const preference = useSyncExternalStore(
    subscribeNoop,
    () => clientPreference,
    getServerPreference,
  );

  return (
    <div className="mb-6 rounded-xl border border-border p-4">
      <p className="mb-1 text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Appearance
      </p>
      <p className="mb-3 text-sm text-foreground-muted">Choose how Veriqen looks on this device.</p>

      <div
        role="radiogroup"
        aria-label="Appearance"
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {APPEARANCE_VALUES.map((value) => {
          const Icon = APPEARANCE_ICONS[value];
          const active = value === preference;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(value)}
              className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                active ? "border-accent bg-accent/10" : "border-border hover:bg-surface-muted"
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <Icon size={16} className={active ? "text-accent" : "text-foreground-muted"} />
                {active && <Check size={15} className="text-accent" aria-hidden />}
              </div>
              <span className="text-sm font-semibold">{APPEARANCE_LABELS[value]}</span>
              <span className="text-xs text-foreground-muted">
                {APPEARANCE_DESCRIPTIONS[value]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
