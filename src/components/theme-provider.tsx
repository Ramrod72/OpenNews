"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";
import { ThemeSanitizer } from "@/components/ui/ThemeSanitizer";
import { APPEARANCE_VALUES } from "@/lib/appearance";

/**
 * Repairs a corrupted/hand-edited localStorage["theme"] value in place,
 * before next-themes' own bootstrap script (rendered a moment later, as
 * a child of NextThemesProvider below) ever reads it. This is belt-and-
 * suspenders with ThemeSanitizer, not a replacement for it: next-themes
 * applies whatever string is stored as a literal classList.add(...) with
 * no validation, and a value containing characters invalid for a class
 * token (e.g. a space) throws inside next-themes' own effect and crashes
 * the whole page (confirmed: Next.js falls back to its client-side error
 * screen) — before ThemeSanitizer, which only runs after React mounts,
 * ever gets a chance to reset it. Fixing the stored value first avoids
 * that crash entirely and means the invalid value is never applied as a
 * class in the first place, so there's no stray residue class to clean
 * up either. It intentionally touches only this one known key, not a
 * general classList scrub.
 */
const GUARD_SCRIPT = `try{var v=localStorage.getItem("theme");if(v!==null&&${JSON.stringify(APPEARANCE_VALUES)}.indexOf(v)===-1){localStorage.setItem("theme","system")}}catch(e){}`;

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <>
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: GUARD_SCRIPT }} />
      <NextThemesProvider {...props}>
        <ThemeSanitizer />
        {children}
      </NextThemesProvider>
    </>
  );
}
