import { describe, expect, it } from "vitest";
import { shouldRenderAds } from "@/components/ads/shouldRenderAds";

describe("shouldRenderAds", () => {
  it("viewer not allowed (Basic/Pro, or not yet resolved): never renders, regardless of admin config", () => {
    expect(shouldRenderAds(false, true, true)).toBe(false);
    expect(shouldRenderAds(null, true, true)).toBe(false);
  });

  it("viewer allowed + global disabled: does not render", () => {
    expect(shouldRenderAds(true, false, true)).toBe(false);
  });

  it("viewer allowed + global enabled + this slot disabled: does not render", () => {
    expect(shouldRenderAds(true, true, false)).toBe(false);
  });

  it("viewer allowed + global enabled + slot enabled: renders", () => {
    expect(shouldRenderAds(true, true, true)).toBe(true);
  });
});
