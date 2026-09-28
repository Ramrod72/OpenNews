"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { isValidAppearancePreference } from "@/lib/appearance";

/**
 * next-themes persists whatever string it's given with no validation of
 * its own — a corrupted or hand-edited localStorage value (anything other
 * than "system"/"light"/"dark") gets applied as a literal, unrecognized
 * HTML class and is never resolved against the OS preference again,
 * effectively freezing the site on whatever appearance that garbage value
 * happens to fall back to. This runs once after mount and self-heals by
 * resetting to "system", the documented safe default, the moment it finds
 * anything else. A no-op on every normal visit.
 */
export function ThemeSanitizer() {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (theme !== undefined && !isValidAppearancePreference(theme)) {
      setTheme("system");
    }
  }, [theme, setTheme]);

  return null;
}
