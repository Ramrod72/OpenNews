import { describe, expect, it } from "vitest";
import { compareHeadlines } from "./headlineComparison";

function article(overrides: Partial<Parameters<typeof compareHeadlines>[0][number]> = {}) {
  return {
    id: "a1",
    title: "Reuters: Talks conclude in Geneva",
    url: "https://example.com/a1",
    source: { id: "src-1", name: "Example News" },
    ...overrides,
  };
}

describe("headline entries", () => {
  it("builds one entry per article with entities/numbers/perspective", () => {
    const view = compareHeadlines([article()]);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]!.perspective).toBe("reporting");
    expect(view.entries[0]!.entities).toContain("Reuters");
  });

  it("classifies publisher-labeled opinion/analysis via existing perspective.ts, never invents its own", () => {
    const view = compareHeadlines([article({ id: "a1", url: "https://example.com/opinion/take" })]);
    expect(view.entries[0]!.perspective).toBe("opinion");
  });

  it("extracts numbers from headlines using the same closed-set unit patterns as claims", () => {
    const view = compareHeadlines([article({ title: "12 people injured in Geneva blast" })]);
    expect(view.entries[0]!.numbers).toEqual([{ unit: "INJURIES", numericValue: 12 }]);
  });
});

describe("sharedEntities", () => {
  it("lists entities mentioned in 2+ headlines, not just one", () => {
    const view = compareHeadlines([
      article({ id: "a1", title: "Reuters: Talks conclude in Geneva" }),
      article({ id: "a2", title: "AP: Geneva talks reach agreement" }),
      article({ id: "a3", title: "Local reaction to the deal" }),
    ]);
    expect(view.sharedEntities).toContain("Geneva");
  });
});

describe("empty input", () => {
  it("returns empty entries/sharedEntities for no articles", () => {
    const view = compareHeadlines([]);
    expect(view.entries).toEqual([]);
    expect(view.sharedEntities).toEqual([]);
  });
});

describe("hostile input", () => {
  it("never throws on hostile HTML/Unicode in a title", () => {
    expect(() =>
      compareHeadlines([article({ title: '<script>alert(1)</script> "quotes" & Geneva' })]),
    ).not.toThrow();
  });
});
