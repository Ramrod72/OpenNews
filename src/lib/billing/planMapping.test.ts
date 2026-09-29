import { describe, expect, it } from "vitest";
import { isPaidPlanSlug, planSlugForPriceId, priceIdForPlan, PAID_PLAN_SLUGS } from "./planMapping";
import type { BillingConfig } from "./config";

const config: BillingConfig = {
  enabled: true,
  mode: "test",
  secretKey: "sk_test_x",
  webhookSecret: "whsec_x",
  priceIds: { basic: "price_basic_123", pro: "price_pro_456" },
};

describe("isPaidPlanSlug (D/E: closed plan enum)", () => {
  it("accepts exactly 'basic' and 'pro'", () => {
    expect(isPaidPlanSlug("basic")).toBe(true);
    expect(isPaidPlanSlug("pro")).toBe(true);
    expect(PAID_PLAN_SLUGS).toEqual(["basic", "pro"]);
  });

  it("rejects any other value, including plausible-looking or hostile strings", () => {
    for (const bad of [
      "free",
      "Pro",
      "PRO",
      "basic ",
      " pro",
      "enterprise",
      "",
      "basic\0",
      "pro; DROP TABLE",
      123,
      null,
      undefined,
      {},
      ["pro"],
    ]) {
      expect(isPaidPlanSlug(bad)).toBe(false);
    }
  });
});

describe("priceIdForPlan — server-side-only resolution", () => {
  it("resolves the trusted price id for each validated plan", () => {
    expect(priceIdForPlan(config, "basic")).toBe("price_basic_123");
    expect(priceIdForPlan(config, "pro")).toBe("price_pro_456");
  });
});

describe("planSlugForPriceId — reverse mapping used only for webhook sync", () => {
  it("resolves a trusted price id to its plan slug", () => {
    expect(planSlugForPriceId(config, "price_basic_123")).toBe("basic");
    expect(planSlugForPriceId(config, "price_pro_456")).toBe("pro");
  });

  it("AE: an unrecognized price id resolves to null — never a guessed plan", () => {
    expect(planSlugForPriceId(config, "price_totally_unknown")).toBeNull();
    expect(planSlugForPriceId(config, "")).toBeNull();
  });
});
