import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CSRF_HEADER as ADMIN_CSRF_HEADER } from "../src/lib/auth/csrf";
import { getSessionOptions as getAdminSessionOptions } from "../src/lib/auth/sessionOptions";
import { CSRF_HEADER as CONSUMER_CSRF_HEADER } from "../src/lib/auth/consumer/csrf";
import { SESSION_COOKIE_NAME as CONSUMER_SESSION_COOKIE_NAME } from "../src/lib/auth/consumer/sessionOptions";

/**
 * Regression test for the Veriqen -> Veriqen News public rebrand (PR #24).
 *
 * This deliberately does NOT ban the bare word "Veriqen" anywhere in the
 * repository — several things must keep saying exactly that:
 *   - VeriqenBot/1.0 (the ingestion User-Agent; publisher servers can
 *     observe/filter it, so it's out of scope for this rebrand)
 *   - veriqen_session / x-veriqen-account / opennews_admin_session /
 *     x-opennews-admin / veriqenUserId (compatibility-sensitive cookie,
 *     CSRF header, and billing-metadata identifiers — renaming any of
 *     these breaks live sessions or Stripe metadata)
 *   - veriqennews.com (the correct public domain)
 *
 * Instead, this scans only the specific human-visible, public-facing
 * source files this rebrand touched, for a bare "Veriqen" that ISN'T
 * followed by "News" — i.e. an old-brand string that should have become
 * "Veriqen News" but didn't. A plain \bVeriqen\b word-boundary match
 * also naturally skips camelCase internal identifiers (e.g.
 * `HowVeriqenTraces`), since there's no word boundary between "How" and
 * "Veriqen" or between "Veriqen" and "Traces" there.
 */

const STRAY_OLD_BRAND = /\bVeriqen\b(?!\s*News)/;

// Every file this rebrand updated with public, human-visible brand copy.
const PUBLIC_BRAND_FILES = [
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/about/page.tsx",
  "src/app/account/AppearanceSection.tsx",
  "src/app/pricing/page.tsx",
  "src/app/sources/page.tsx",
  "src/app/sources/[id]/page.tsx",
  "src/app/story/[slug]/page.tsx",
  "src/app/admin/(protected)/settings/SettingsForm.tsx",
  "src/app/admin/(protected)/sources/[id]/SourceProfileManager.tsx",
  "src/components/layout/Header.tsx",
  "src/components/layout/Footer.tsx",
  "src/components/pricing/FeatureComparisonTable.tsx",
  "src/components/pricing/PlanCard.tsx",
  "src/components/story/AiStoryBrief.tsx",
  "src/components/story/CoverageComparison.tsx",
  "src/components/story/EvidenceDrawer.tsx",
  "src/components/story/StoryIntelligence.tsx",
  "src/lib/ai/storyBrief/prompt.ts",
  "src/lib/coverageComparisonView.ts",
];

describe("branding: public-facing copy says Veriqen News", () => {
  it.each(PUBLIC_BRAND_FILES)("%s has no stray old-brand 'Veriqen' occurrence", (relPath) => {
    const content = readFileSync(path.resolve(__dirname, "..", relPath), "utf-8");
    const strayLines = content
      .split("\n")
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => STRAY_OLD_BRAND.test(line));

    expect(strayLines, JSON.stringify(strayLines)).toHaveLength(0);
  });

  it("the detector itself actually catches an old-brand regression", () => {
    expect(STRAY_OLD_BRAND.test("Veriqen is an open-source project.")).toBe(true);
    expect(STRAY_OLD_BRAND.test("About Veriqen")).toBe(true);
  });

  it("the detector does not false-positive on the new brand or internal identifiers", () => {
    expect(STRAY_OLD_BRAND.test("Veriqen News is an open-source project.")).toBe(false);
    expect(STRAY_OLD_BRAND.test("Veriqen News's own structured claim")).toBe(false);
    expect(STRAY_OLD_BRAND.test("<HowVeriqenTraces />")).toBe(false);
    expect(STRAY_OLD_BRAND.test("function HowVeriqenTraces() {")).toBe(false);
    expect(STRAY_OLD_BRAND.test("VeriqenBot/1.0")).toBe(false);
  });
});

describe("branding: compatibility-sensitive internal identifiers are preserved", () => {
  it("consumer session cookie name is unchanged", () => {
    expect(CONSUMER_SESSION_COOKIE_NAME).toBe("veriqen_session");
  });

  it("consumer CSRF header is unchanged", () => {
    expect(CONSUMER_CSRF_HEADER).toBe("x-veriqen-account");
  });

  it("admin CSRF header is unchanged", () => {
    expect(ADMIN_CSRF_HEADER).toBe("x-opennews-admin");
  });

  it("admin session cookie name is unchanged", () => {
    expect(getAdminSessionOptions().cookieName).toBe("opennews_admin_session");
  });

  it("the ingestion bot User-Agent default is unchanged", () => {
    const content = readFileSync(
      path.resolve(__dirname, "..", "src/lib/ingest/fetchFeed.ts"),
      "utf-8",
    );
    expect(content).toContain("VeriqenBot/1.0");
  });

  it("Stripe billing metadata key is unchanged", () => {
    const content = readFileSync(
      path.resolve(__dirname, "..", "src/lib/billing/provider.ts"),
      "utf-8",
    );
    expect(content).toContain("veriqenUserId");
  });

  it("personalization localStorage keys are unchanged", () => {
    const content = readFileSync(
      path.resolve(__dirname, "..", "src/lib/hooks/usePersonalization.ts"),
      "utf-8",
    );
    expect(content).toContain("opennews:bookmarks");
    expect(content).toContain("opennews:followed");
    expect(content).toContain("opennews:hidden");
    expect(content).toContain("opennews:savedSearches");
  });
});
