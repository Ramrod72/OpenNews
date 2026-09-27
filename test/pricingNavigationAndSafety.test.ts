import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return statSync(full).isFile() ? [full] : [];
  });
}

describe("Pricing navigation", () => {
  it("Header links to /pricing", () => {
    const source = readFileSync(join(ROOT, "src/components/layout/Header.tsx"), "utf8");
    expect(source).toMatch(/href="\/pricing"/);
  });

  it("MobileNav links to /pricing", () => {
    const source = readFileSync(join(ROOT, "src/components/layout/MobileNav.tsx"), "utf8");
    expect(source).toMatch(/href="\/pricing"/);
  });
});

describe("No upgrade control can mutate a user's plan", () => {
  const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));

  it("scans every API route file (sanity check that the scan itself found real files)", () => {
    expect(apiFiles.length).toBeGreaterThan(5);
  });

  it("no API route writes to subscription/plan state except the known registration path", () => {
    const mutators = /subscription\.(create|update|upsert|delete)|planId\s*:/;
    const offenders = apiFiles.filter((file) => mutators.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the consumer-auth service (the one legitimate place a Subscription is created) always assigns the Free plan, never a client-supplied plan", () => {
    const source = readFileSync(join(ROOT, "src/lib/auth/consumer/service.ts"), "utf8");
    expect(source).toMatch(/subscription\.create/);
    // Nothing in registerUser's input type or body accepts a plan/planId from the caller.
    expect(source).not.toMatch(/input\.plan/);
    expect(source).toMatch(/planId:\s*freePlan\.id/);
  });

  it("the shared UpgradeButton never calls fetch() — it only ever displays an explanatory message", () => {
    const source = readFileSync(join(ROOT, "src/components/pricing/UpgradeButton.tsx"), "utf8");
    expect(source).not.toMatch(/fetch\(/);
  });
});
