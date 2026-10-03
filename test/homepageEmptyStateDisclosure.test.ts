import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const homepageSource = readFileSync(join(ROOT, "src/app/page.tsx"), "utf8");

/**
 * The homepage's "no stories yet" empty state is shown to real, public,
 * unauthenticated visitors — it must never leak operator/developer-only
 * instructions (shell commands, filenames, doc references) that have no
 * meaning to an end user and only reveal how the deployment's internals
 * work. This previously happened (`npm run ingest`, `npm run worker`,
 * `DEPLOYMENT.md`) and is the exact regression this guards against.
 */
describe("homepage empty-state never discloses operator-only instructions", () => {
  const OPERATOR_TOKENS = ["npm run", "DEPLOYMENT.md", "npm start", ".env"];

  for (const token of OPERATOR_TOKENS) {
    it(`never contains "${token}"`, () => {
      expect(homepageSource).not.toContain(token);
    });
  }

  it("still shows a plain, public-facing explanation when there are no stories", () => {
    expect(homepageSource).toMatch(/No stories (yet|available)/i);
    expect(homepageSource).toMatch(/check back soon/i);
  });
});
