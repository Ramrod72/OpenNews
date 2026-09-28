/**
 * The three appearance preferences Veriqen supports. Shared by every UI
 * that lets a visitor change it (the header's compact control and the
 * Account → Appearance section) and by the sanitizer that guards against
 * a corrupted persisted value, so there is exactly one definition of what
 * "valid" means.
 */
export const APPEARANCE_VALUES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_VALUES)[number];

export const APPEARANCE_LABELS: Record<AppearancePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export const APPEARANCE_DESCRIPTIONS: Record<AppearancePreference, string> = {
  system: "Match your device's setting",
  light: "Always use the light theme",
  dark: "Always use the dark theme",
};

/**
 * True only for one of the three supported preferences. next-themes
 * persists whatever string it's given to localStorage with no validation
 * of its own (confirmed by reading its source: an invalid/corrupted value
 * is applied as a literal, unrecognized HTML class and never resolved
 * against the OS preference) — this is what the sanitizer in
 * ThemeSanitizer.tsx checks before deciding to reset to "system".
 */
export function isValidAppearancePreference(value: unknown): value is AppearancePreference {
  return typeof value === "string" && (APPEARANCE_VALUES as readonly string[]).includes(value);
}
