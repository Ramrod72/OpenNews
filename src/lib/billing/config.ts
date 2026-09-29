/**
 * Phase 12B's billing configuration — environment variables only, no
 * AdminSetting/database override (unlike src/lib/ai/config.ts's AI
 * settings, which are non-secret operator preferences; STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET are real secrets and must never live in a
 * database row an admin-panel bug could ever expose).
 *
 * Test/live isolation (Phase 12A Amendment A): mode is never GUESSED from
 * a Price id's or webhook secret's own formatting — neither is documented
 * by Stripe to encode test/live mode. Instead:
 *  - STRIPE_MODE ("test" | "live") is an explicit, required application
 *    setting — the single source of truth for which mode this deployment
 *    runs in (this app supports exactly one mode per deployment, matching
 *    the "one Stripe account per environment" model every Stripe
 *    integration guide recommends).
 *  - STRIPE_SECRET_KEY's prefix is cross-checked against that declared
 *    mode using ONLY the prefix convention Stripe's own API documentation
 *    explicitly guarantees (secret/restricted keys are prefixed
 *    sk_test_/rk_test_ in test mode, sk_live_/rk_live_ in live mode) — a
 *    documented Stripe guarantee, not a reverse-engineered assumption
 *    about Price id or webhook-secret formatting.
 * A mismatch, or any required variable being unset, disables billing
 * entirely (getBillingConfig() returns `{ enabled: false }`) rather than
 * falling back to a default mode or guessing — see this module's own
 * test file for the explicit "cannot silently fall back" proof.
 */

export interface BillingConfig {
  enabled: true;
  mode: "test" | "live";
  secretKey: string;
  webhookSecret: string;
  /** Trusted Stripe Price id for each Veriqen paid plan slug. */
  priceIds: { basic: string; pro: string };
}

export interface BillingDisabled {
  enabled: false;
  /** For server logs only — never shown to an end user (see billing routes). */
  reason: string;
}

export type BillingConfigResult = BillingConfig | BillingDisabled;

function prefixForMode(mode: "test" | "live"): readonly [string, string] {
  return mode === "test"
    ? (["sk_test_", "rk_test_"] as const)
    : (["sk_live_", "rk_live_"] as const);
}

/**
 * Resolves billing configuration fresh from `process.env` on every call —
 * deliberately not cached at module load, so a test can set/unset env vars
 * per-case without any module-reset gymnastics (same convention
 * src/lib/ai/config.ts's own env-reading functions already follow).
 */
export function getBillingConfig(): BillingConfigResult {
  const mode = process.env.STRIPE_MODE;
  if (mode !== "test" && mode !== "live") {
    return { enabled: false, reason: "STRIPE_MODE must be set to exactly 'test' or 'live'" };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const basicPriceId = process.env.STRIPE_BASIC_PRICE_ID?.trim();
  const proPriceId = process.env.STRIPE_PRO_PRICE_ID?.trim();

  if (!secretKey || !webhookSecret || !basicPriceId || !proPriceId) {
    return {
      enabled: false,
      reason:
        "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_BASIC_PRICE_ID, and STRIPE_PRO_PRICE_ID must all be set",
    };
  }

  const allowedPrefixes = prefixForMode(mode);
  if (!allowedPrefixes.some((prefix) => secretKey.startsWith(prefix))) {
    return {
      enabled: false,
      reason: `STRIPE_SECRET_KEY does not start with ${allowedPrefixes.join(" or ")}, which does not match STRIPE_MODE=${mode} — refusing to guess which mode is intended`,
    };
  }

  if (basicPriceId === proPriceId) {
    return {
      enabled: false,
      reason: "STRIPE_BASIC_PRICE_ID and STRIPE_PRO_PRICE_ID must not be the same value",
    };
  }

  return {
    enabled: true,
    mode,
    secretKey,
    webhookSecret,
    priceIds: { basic: basicPriceId, pro: proPriceId },
  };
}
