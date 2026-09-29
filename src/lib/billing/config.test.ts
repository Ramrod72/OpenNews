import { afterEach, describe, expect, it } from "vitest";
import { getBillingConfig } from "./config";

const ENV_KEYS = [
  "STRIPE_MODE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_BASIC_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  setEnv(originalEnv);
});

const VALID_TEST_CONFIG = {
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  STRIPE_WEBHOOK_SECRET: "whsec_abc123",
  STRIPE_BASIC_PRICE_ID: "price_basic_test",
  STRIPE_PRO_PRICE_ID: "price_pro_test",
} as const;

describe("getBillingConfig — happy path", () => {
  it("returns an enabled config when every variable is set and consistent", () => {
    setEnv(VALID_TEST_CONFIG);
    const result = getBillingConfig();
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.mode).toBe("test");
      expect(result.priceIds).toEqual({ basic: "price_basic_test", pro: "price_pro_test" });
    }
  });

  it("also accepts a live mode with an sk_live_ key", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_live_abc123" });
    const result = getBillingConfig();
    expect(result).toMatchObject({ enabled: true, mode: "live" });
  });

  it("accepts a restricted key (rk_test_/rk_live_) using the same officially-documented prefix convention", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_SECRET_KEY: "rk_test_abc123" });
    expect(getBillingConfig().enabled).toBe(true);
  });
});

describe("BE: missing configuration fails closed", () => {
  it("disables billing when STRIPE_MODE is entirely unset", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_MODE: undefined });
    expect(getBillingConfig()).toEqual({ enabled: false, reason: expect.any(String) });
  });

  it("disables billing when STRIPE_SECRET_KEY is unset", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_SECRET_KEY: undefined });
    expect(getBillingConfig().enabled).toBe(false);
  });

  it("disables billing when STRIPE_WEBHOOK_SECRET is unset", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_WEBHOOK_SECRET: undefined });
    expect(getBillingConfig().enabled).toBe(false);
  });

  it("disables billing when either price id is unset", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_BASIC_PRICE_ID: undefined });
    expect(getBillingConfig().enabled).toBe(false);
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_PRO_PRICE_ID: undefined });
    expect(getBillingConfig().enabled).toBe(false);
  });

  it("disables billing entirely when nothing at all is configured (self-hosted deployment with no billing)", () => {
    setEnv({
      STRIPE_MODE: undefined,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_BASIC_PRICE_ID: undefined,
      STRIPE_PRO_PRICE_ID: undefined,
    });
    expect(getBillingConfig()).toEqual({ enabled: false, reason: expect.any(String) });
  });
});

describe("BF: test/live configuration cannot silently fall back or cross-map environments (Amendment A)", () => {
  it("rejects STRIPE_MODE set to anything other than exactly 'test' or 'live' — never defaults to either", () => {
    for (const badMode of ["Test", "TEST", "production", "sandbox", "", "true", "1"]) {
      setEnv({ ...VALID_TEST_CONFIG, STRIPE_MODE: badMode });
      const result = getBillingConfig();
      expect(result.enabled).toBe(false);
    }
  });

  it("rejects a live secret key when STRIPE_MODE=test — never silently treats it as test mode", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_live_abc123" });
    const result = getBillingConfig();
    expect(result).toEqual({ enabled: false, reason: expect.stringContaining("STRIPE_MODE=test") });
  });

  it("rejects a test secret key when STRIPE_MODE=live — never silently treats it as live mode", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_test_abc123" });
    const result = getBillingConfig();
    expect(result).toEqual({ enabled: false, reason: expect.stringContaining("STRIPE_MODE=live") });
  });

  it("never infers mode from the Price id's or webhook secret's own formatting — a mode-inconsistent secret key still fails closed even when the price ids/webhook secret 'look' fine", () => {
    // Price ids and the webhook secret carry NO documented mode indicator at
    // all (Amendment A) — this test proves the config module doesn't try to
    // read one anyway: the ONLY signal it cross-checks is the secret key's
    // own Stripe-documented prefix against the explicit STRIPE_MODE.
    setEnv({
      STRIPE_MODE: "live",
      STRIPE_SECRET_KEY: "sk_test_shouldFailInLiveMode",
      STRIPE_WEBHOOK_SECRET: "whsec_this_looks_identical_in_both_modes",
      STRIPE_BASIC_PRICE_ID: "price_basic_test", // deliberately a "test-looking" id, but Stripe gives price ids no mode-indicating format at all
      STRIPE_PRO_PRICE_ID: "price_pro_test",
    });
    expect(getBillingConfig().enabled).toBe(false);
  });

  it("rejects identical basic/pro price ids (a configuration error that would map both plans to the same Stripe object)", () => {
    setEnv({ ...VALID_TEST_CONFIG, STRIPE_PRO_PRICE_ID: VALID_TEST_CONFIG.STRIPE_BASIC_PRICE_ID });
    expect(getBillingConfig().enabled).toBe(false);
  });
});
