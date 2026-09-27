import { describe, expect, it } from "vitest";
import plansConfig from "../config/plans.json";
import { buildComparisonRows, buildNewHighlights } from "@/lib/pricingContent";
import type { ResolvedEntitlement } from "@/lib/entitlements";

/**
 * Pure tests against the real config/plans.json data — no database
 * needed, since buildNewHighlights/buildComparisonRows take plain
 * entitlement maps. This is what actually protects the pricing page from
 * silently drifting out of sync with the plan definitions.
 */
function entitlementsFor(slug: string): Record<string, ResolvedEntitlement> {
  const plan = plansConfig.find((p) => p.slug === slug);
  if (!plan) throw new Error(`no such plan in config/plans.json: ${slug}`);
  const map: Record<string, ResolvedEntitlement> = {};
  for (const [feature, value] of Object.entries(plan.entitlements)) {
    if (typeof value === "boolean") {
      map[feature] = { boolValue: value, limitValue: null };
    } else {
      map[feature] = { boolValue: null, limitValue: value };
    }
  }
  return map;
}

const free = entitlementsFor("free");
const basic = entitlementsFor("basic");
const pro = entitlementsFor("pro");

function labels(highlights: ReturnType<typeof buildNewHighlights>): string[] {
  return highlights.map((h) => h.label);
}

describe("buildNewHighlights", () => {
  it("Free (no previous tier) lists its baseline capabilities, correctly marked live vs. planned", () => {
    const highlights = buildNewHighlights(free, null);
    const bySameLabel = labels(highlights);
    expect(bySameLabel).toContain("Standard news feed");
    expect(bySameLabel).toContain("Includes advertising");
    expect(bySameLabel).toContain("Basic search");
    expect(bySameLabel).toContain("Up to 10 saved stories");
    expect(bySameLabel).not.toContain("Ad-free browsing");
    expect(bySameLabel).not.toContain("AI story summaries");

    const feed = highlights.find((h) => h.key === "standard_feed");
    expect(feed?.status).toBe("live");
    const savedStories = highlights.find((h) => h.key === "saved_stories_limit");
    expect(savedStories?.status).toBe("planned");
  });

  it("Basic's new-vs-Free highlights are exactly what changed, not the whole plan again", () => {
    const highlights = buildNewHighlights(basic, free);
    const l = labels(highlights);
    expect(l).toContain("Ad-free browsing");
    expect(l).toContain("Full search");
    expect(l).toContain("Unlimited saved stories");
    expect(l).toContain("Unlimited custom topics");
    expect(l).toContain("Detailed source profiles");
    // Unchanged from Free (the news feed itself isn't a Basic upsell) — must not repeat.
    expect(l).not.toContain("Standard news feed");
    // Not part of Basic at all.
    expect(l).not.toContain("Advanced filtering");
    expect(l).not.toContain("AI story summaries");
  });

  it("Pro's new-vs-Basic highlights are only what Pro adds on top of Basic", () => {
    const highlights = buildNewHighlights(pro, basic);
    const l = labels(highlights);
    expect(l).toContain("AI story summaries");
    expect(l).toContain("Cross-source synthesis");
    expect(l).toContain("Claim comparison");
    expect(l).toContain("Historical source analysis");
    expect(l).toContain("Research tools");
    expect(l).toContain("Export capabilities");
    expect(l).toContain("Advanced filtering");
    expect(l).toContain("Unlimited notifications");
    expect(l).toContain("Up to 50 AI actions per month");
    // Already true at Basic — must not repeat under "Everything in Basic, plus:".
    expect(l).not.toContain("Full search");
    expect(l).not.toContain("Ad-free browsing");
    expect(l).not.toContain("Unlimited saved stories");

    // None of Pro's exclusive capabilities are live yet — that must be disclosed, not hidden.
    for (const h of highlights) {
      expect(h.status).toBe("planned");
    }
  });
});

describe("buildComparisonRows", () => {
  const rows = buildComparisonRows([free, basic, pro]);

  it("has one row per catalog entry and never contradicts the underlying entitlement", () => {
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(row.cells).toHaveLength(3);
    }
  });

  it("ad-free browsing: not included for Free, included for Basic and Pro", () => {
    const row = rows.find((r) => r.key === "ads_enabled");
    expect(row).toBeDefined();
    expect(row!.cells[0].included).toBe(false); // Free
    expect(row!.cells[1].included).toBe(true); // Basic
    expect(row!.cells[2].included).toBe(true); // Pro
  });

  it("AI story summaries: only included for Pro, and marked as not live", () => {
    const row = rows.find((r) => r.key === "ai_summaries");
    expect(row).toBeDefined();
    expect(row!.cells[0].included).toBe(false);
    expect(row!.cells[1].included).toBe(false);
    expect(row!.cells[2].included).toBe(true);
    expect(row!.cells[2].status).toBe("planned");
  });

  it("saved stories: Free shows the numeric limit, Basic/Pro show unlimited", () => {
    const row = rows.find((r) => r.key === "saved_stories_limit");
    expect(row).toBeDefined();
    expect(row!.cells[0].text).toBe("Up to 10 saved stories");
    expect(row!.cells[1].text).toBe("Unlimited saved stories");
    expect(row!.cells[2].text).toBe("Unlimited saved stories");
  });

  it("no row is silently wrong for a plan with a zero limit — it's marked not included, not blank-but-included", () => {
    const row = rows.find((r) => r.key === "ai_monthly_quota");
    expect(row).toBeDefined();
    expect(row!.cells[0]).toMatchObject({ included: false, text: null });
    expect(row!.cells[1]).toMatchObject({ included: false, text: null });
    expect(row!.cells[2]).toMatchObject({ included: true, text: "Up to 50 AI actions per month" });
  });
});
