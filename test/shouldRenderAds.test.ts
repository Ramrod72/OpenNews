import { describe, expect, it } from "vitest";
import { shouldRenderAds } from "@/components/ads/shouldRenderAds";

describe("shouldRenderAds", () => {
  it("global disabled: never renders, regardless of viewer eligibility", () => {
    expect(shouldRenderAds(false, true)).toBe(false);
    expect(shouldRenderAds(false, false)).toBe(false);
    expect(shouldRenderAds(false, null)).toBe(false);
  });

  it("global enabled + viewer allows ads: renders", () => {
    expect(shouldRenderAds(true, true)).toBe(true);
  });

  it("global enabled + viewer does not allow ads (Basic/Pro): does not render", () => {
    expect(shouldRenderAds(true, false)).toBe(false);
  });

  it("global enabled + eligibility not yet resolved: does not render (fail closed while pending)", () => {
    expect(shouldRenderAds(true, null)).toBe(false);
  });
});
