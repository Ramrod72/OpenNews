import { getBillingConfig, type BillingConfig } from "./config";
import { createStripeProvider } from "./stripeProvider";
import type { BillingProvider } from "./provider";

export type RuntimeBillingResult =
  | { enabled: true; provider: BillingProvider; config: BillingConfig }
  | { enabled: false; reason: string };

/**
 * The one place route handlers get a real, config-backed BillingProvider
 * from — reads env config fresh on every call (see config.ts's own doc
 * comment on why it isn't cached) and constructs a new Stripe SDK client
 * around it. Route handlers never import createStripeProvider directly.
 */
export function getRuntimeBilling(): RuntimeBillingResult {
  const config = getBillingConfig();
  if (!config.enabled) {
    return { enabled: false, reason: config.reason };
  }
  const provider = createStripeProvider({
    secretKey: config.secretKey,
    webhookSecret: config.webhookSecret,
  });
  return { enabled: true, provider, config };
}
