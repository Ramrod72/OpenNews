import { describe, expect, it } from "vitest";
import { claimTokenSet, normalizeClaimText } from "./normalize";

describe("normalizeClaimText", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeClaimText("Reuters reported the news!")).toBe("reuters reported news");
  });

  it("never throws on hostile Unicode/control characters", () => {
    expect(() => normalizeClaimText("‮Reuters‬ reported.")).not.toThrow();
    expect(() => normalizeClaimText("𝕽𝖊𝖚𝖙𝖊𝖗𝖘 reported")).not.toThrow();
  });

  it("is deterministic", () => {
    const text = "Reuters reported the negotiations concluded.";
    expect(normalizeClaimText(text)).toBe(normalizeClaimText(text));
  });
});

describe("claimTokenSet", () => {
  it("tokenizes normalized text into a Set", () => {
    const set = claimTokenSet(normalizeClaimText("Reuters reported the news"));
    expect(set.has("reuters")).toBe(true);
    expect(set.has("reported")).toBe(true);
  });
});
