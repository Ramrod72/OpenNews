import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 14B — M1 regression guard: Phase 13 fixed a bug where every page
 * under /admin/(protected) was being statically prerendered at build time
 * (admin auth is enforced by middleware, not by a cookies()/headers() call
 * inside the page itself, so nothing else forces dynamic rendering) --
 * except src/app/admin/(protected)/sources/[id]/page.tsx, which Phase 13
 * missed. Rather than re-listing each fixed file by name (as the earlier
 * Phase 13B tests did, which is exactly how this one page slipped through),
 * this walks the actual directory tree so a FUTURE new admin page can never
 * silently reintroduce the same bug class by omission.
 */
const PROTECTED_ADMIN_DIR = join(__dirname, "..", "src", "app", "admin", "(protected)");

function findPageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPageFiles(full));
    } else if (entry.name === "page.tsx") {
      found.push(full);
    }
  }
  return found;
}

describe("every protected admin page forces dynamic rendering", () => {
  const pageFiles = findPageFiles(PROTECTED_ADMIN_DIR);

  it("finds at least the known set of protected admin pages (sanity check the walk itself works)", () => {
    expect(pageFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of pageFiles) {
    const relative = file.slice(join(__dirname, "..").length + 1);
    it(`${relative} exports dynamic = "force-dynamic"`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/export const dynamic = ["']force-dynamic["']/);
    });
  }
});

describe("the login page correctly remains static (no data dependency, not under (protected))", () => {
  it("src/app/admin/login/page.tsx does not force dynamic rendering", () => {
    const source = readFileSync(
      join(__dirname, "..", "src", "app", "admin", "login", "page.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/force-dynamic/);
  });
});
