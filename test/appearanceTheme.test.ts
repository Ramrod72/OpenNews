import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Recursively collects every .tsx file under a directory (no external tools/subprocesses). */
function collectTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsxFiles(full));
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

describe("System is the default appearance", () => {
  it('the root ThemeProvider is configured with defaultTheme="system" and enableSystem', () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/defaultTheme="system"/);
    expect(layout).toMatch(/enableSystem/);
  });

  it("theme transitions are disabled (no jarring animated color sweep on switch)", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/disableTransitionOnChange/);
  });

  it("the class attribute strategy is used (matches globals.css's .dark selector)", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/attribute="class"/);
  });
});

describe("ThemeSanitizer is wired in — invalid persisted values self-heal", () => {
  it("theme-provider.tsx renders ThemeSanitizer as a child of NextThemesProvider", () => {
    const provider = read("src/components/theme-provider.tsx");
    expect(provider).toMatch(/<ThemeSanitizer\s*\/>/);
  });

  it('ThemeSanitizer resets to "system" only for an invalid value, using the shared validator (not a duplicated/inline check)', () => {
    const sanitizer = read("src/components/ui/ThemeSanitizer.tsx");
    expect(sanitizer).toMatch(/isValidAppearancePreference/);
    expect(sanitizer).toMatch(/setTheme\("system"\)/);
  });
});

describe("semantic theme tokens exist for both light and dark", () => {
  const REQUIRED_TOKENS = [
    "--background",
    "--surface",
    "--surface-muted",
    "--border",
    "--foreground",
    "--foreground-muted",
    "--accent",
    "--accent-foreground",
    "--breaking",
    "--success",
  ];

  it("every required token is defined in :root (light) and .dark", () => {
    const css = read("src/app/globals.css");
    const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const darkBlock = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootBlock).not.toBe("");
    expect(darkBlock).not.toBe("");
    for (const token of REQUIRED_TOKENS) {
      expect(rootBlock).toContain(`${token}:`);
      expect(darkBlock).toContain(`${token}:`);
    }
  });

  it("light and dark define different values for every token — dark mode isn't a no-op copy", () => {
    const css = read("src/app/globals.css");
    const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const darkBlock = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? "";
    const valueOf = (block: string, token: string) =>
      block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1].trim();
    for (const token of REQUIRED_TOKENS) {
      expect(valueOf(darkBlock, token)).not.toBe(valueOf(rootBlock, token));
    }
  });

  it("color-scheme is set for both html (light) and html.dark, so native form controls render correctly in each theme", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*light/);
    expect(css).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark/);
  });
});

describe("no hardcoded colors were introduced that would break dark mode", () => {
  it("no raw Tailwind color-palette utility (bg-gray-500, text-blue-600, etc.) appears anywhere in app/component source", () => {
    const PALETTE_UTILITY = new RegExp(
      "\\b(bg|text|border|ring|from|to|via)-" +
        "(red|green|blue|yellow|orange|purple|pink|indigo|teal|cyan|emerald|amber|lime|rose|fuchsia|violet|sky|gray|slate|zinc|neutral|stone)-[0-9]+",
    );
    const offenders: string[] = [];
    for (const dir of [join(ROOT, "src/app"), join(ROOT, "src/components")]) {
      for (const file of collectTsxFiles(dir)) {
        if (PALETTE_UTILITY.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("both appearance controls read/write the same centralized preference", () => {
  it("AppearanceMenu (header) uses next-themes' useTheme, not local/duplicated state", () => {
    const menu = read("src/components/ui/AppearanceMenu.tsx");
    expect(menu).toMatch(/from "next-themes"/);
    expect(menu).toMatch(/useTheme\(\)/);
  });

  it("AppearanceSection (account) uses next-themes' useTheme, not local/duplicated state", () => {
    const section = read("src/app/account/AppearanceSection.tsx");
    expect(section).toMatch(/from "next-themes"/);
    expect(section).toMatch(/useTheme\(\)/);
  });

  it("both controls render all three options by iterating the single shared APPEARANCE_VALUES list, not a hand-duplicated array", () => {
    const menu = read("src/components/ui/AppearanceMenu.tsx");
    const section = read("src/app/account/AppearanceSection.tsx");
    for (const source of [menu, section]) {
      expect(source).toMatch(/APPEARANCE_VALUES\.map/);
      expect(source).toMatch(/from "@\/lib\/appearance"/);
    }
  });
});

describe("appearance is available to anonymous visitors, not gated behind an account", () => {
  it("Header renders AppearanceMenu unconditionally (no auth/session check around it)", () => {
    const header = read("src/components/layout/Header.tsx");
    expect(header).toMatch(/<AppearanceMenu\s*\/>/);
  });

  it("the account page's Appearance section requires no account-specific data (no user fields passed into it)", () => {
    const accountPage = read("src/app/account/page.tsx");
    const call = accountPage.match(/<AppearanceSection[^/]*\/>/)?.[0] ?? "";
    expect(call).toBe("<AppearanceSection />");
  });
});

describe("selection is indicated by more than color alone, and controls are keyboard/screen-reader friendly", () => {
  it("AppearanceMenu marks the active option with aria-checked and a visible Check icon, not color alone", () => {
    const menu = read("src/components/ui/AppearanceMenu.tsx");
    expect(menu).toMatch(/aria-checked=\{active\}/);
    expect(menu).toMatch(/active && <Check/);
    expect(menu).toMatch(/role="menuitemradio"/);
  });

  it("AppearanceSection marks the active option with aria-checked and a visible Check icon, not color alone", () => {
    const section = read("src/app/account/AppearanceSection.tsx");
    expect(section).toMatch(/aria-checked=\{active\}/);
    expect(section).toMatch(/active && <Check/);
    expect(section).toMatch(/role="radio"/);
  });

  it("neither control uses dangerouslySetInnerHTML", () => {
    for (const path of [
      "src/components/ui/AppearanceMenu.tsx",
      "src/app/account/AppearanceSection.tsx",
      "src/components/ui/ThemeSanitizer.tsx",
      "src/components/theme-provider.tsx",
    ]) {
      expect(read(path)).not.toMatch(/dangerouslySetInnerHTML\s*[:=]/);
    }
  });
});

describe("no hydration-mismatch-prone pattern was introduced", () => {
  it("both controls resolve their client-only preference via useSyncExternalStore (server/client snapshot split), not a bare setState-in-effect", () => {
    for (const path of [
      "src/components/ui/AppearanceMenu.tsx",
      "src/app/account/AppearanceSection.tsx",
    ]) {
      const source = read(path);
      expect(source).toMatch(/useSyncExternalStore/);
    }
  });
});
