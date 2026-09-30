import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 15 QA: the pricing page's feature-comparison table has an
 * intentional min-w-[640px] (so its columns stay readable) wrapped in its
 * own overflow-x-auto container — but confirmed via a real Playwright
 * mouse-wheel gesture (not merely reading scrollWidth, which reports a
 * nonzero value regardless of overflow:hidden) that without overflow-x
 * containment on the page root, the ENTIRE page — not just the table —
 * could be panned sideways on a real mobile viewport, because <main> is a
 * flex item of <body> and a flex item's default min-width:auto refuses to
 * shrink below its widest descendant's intrinsic content width. Two
 * independent layers fix this: <main> gets min-w-0 (lets the flex item
 * actually shrink to the viewport), and <html>/<body> get overflow-x-hidden
 * (a standard, harmless belt-and-suspenders guard against any future wide
 * element anywhere in the app forcing the same page-level pan — it does
 * not affect any element's own internal overflow-x-auto scrolling, which
 * keeps working exactly as before). This is a static source check, the
 * same pattern used by test/dockerNetworkExposure.test.ts for a fix that
 * has no unit-testable runtime behavior.
 */
const LAYOUT_PATH = join(__dirname, "..", "src", "app", "layout.tsx");
const TABLE_PATH = join(
  __dirname,
  "..",
  "src",
  "components",
  "pricing",
  "FeatureComparisonTable.tsx",
);

describe("root layout prevents page-level horizontal scroll", () => {
  const source = readFileSync(LAYOUT_PATH, "utf8");

  it("<html> declares overflow-x-hidden", () => {
    const htmlTagMatch = source.match(/<html\b[\s\S]*?\n\s*>/);
    expect(htmlTagMatch).not.toBeNull();
    expect(htmlTagMatch![0]).toMatch(/overflow-x-hidden/);
  });

  it("<body> declares overflow-x-hidden", () => {
    const bodyTagMatch = source.match(/<body\b[^>]*className="[^"]*"/);
    expect(bodyTagMatch).not.toBeNull();
    expect(bodyTagMatch![0]).toMatch(/overflow-x-hidden/);
  });

  it("the <main> flex item declares min-w-0 so it can shrink below its widest descendant", () => {
    const mainTagMatch = source.match(/<main\b[^>]*className="[^"]*"/);
    expect(mainTagMatch).not.toBeNull();
    expect(mainTagMatch![0]).toMatch(/min-w-0/);
  });
});

describe("FeatureComparisonTable keeps its own internal horizontal scroll container", () => {
  const source = readFileSync(TABLE_PATH, "utf8");

  it("wraps the table in an overflow-x-auto container rather than letting it overflow unclipped", () => {
    expect(source).toMatch(/overflow-x-auto/);
  });
});
