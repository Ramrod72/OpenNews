"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

const noop = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Avoids a hydration mismatch (server never knows the theme) without
  // calling setState from an effect: this subscribes to nothing and just
  // reports `true` only once mounted on the client.
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle dark mode"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-muted hover:text-foreground"
    >
      {mounted && resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
