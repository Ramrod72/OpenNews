import type { BillingConfig } from "./config";

/** The only two plan slugs a client may ever request via Checkout. */
export const PAID_PLAN_SLUGS = ["basic", "pro"] as const;
export type PaidPlanSlug = (typeof PAID_PLAN_SLUGS)[number];

export function isPaidPlanSlug(value: unknown): value is PaidPlanSlug {
  return typeof value === "string" && (PAID_PLAN_SLUGS as readonly string[]).includes(value);
}

/** The trusted Stripe Price id for a validated plan slug — server-side resolution only, never accepted from a client. */
export function priceIdForPlan(config: BillingConfig, plan: PaidPlanSlug): string {
  return plan === "basic" ? config.priceIds.basic : config.priceIds.pro;
}

/**
 * The reverse mapping, used ONLY when synchronizing FROM a Stripe
 * subscription's own price id (see webhookSync.ts) — a price id absent
 * from this map is a fail-closed case: the caller must not guess a plan
 * for it, and must not touch any existing local Subscription state (see
 * webhookSync.ts's own handling).
 */
export function planSlugForPriceId(config: BillingConfig, priceId: string): PaidPlanSlug | null {
  if (priceId === config.priceIds.basic) return "basic";
  if (priceId === config.priceIds.pro) return "pro";
  return null;
}
