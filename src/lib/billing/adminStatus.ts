import type { PrismaClient } from "@prisma/client";
import { getRuntimeBilling } from "./runtimeProvider";

/**
 * Phase 13B — READ-ONLY billing status for the admin panel. Reuses
 * Phase 12B's own `getRuntimeBilling()`/`getBillingConfig()` exactly as
 * every billing route already does — this module never re-derives
 * configuration logic, never imports the Stripe SDK, and never makes a
 * live Stripe API call (the admin dashboard must render correctly with
 * billing entirely misconfigured or Stripe unreachable — see this
 * module's own callers for the failure-isolation wrapper).
 *
 * `disabledReason`, when present, is the exact same static diagnostic
 * string `getBillingConfig()` already returns for the (non-admin)
 * billing routes' own server logs — it has never been anything other
 * than a fixed, hand-written sentence (see src/lib/billing/config.ts);
 * it is not, and never becomes, an echo of any env value.
 */
export interface BillingAdminStatus {
  enabled: boolean;
  mode?: "test" | "live";
  disabledReason?: string;
  subscriptionsByStatus: Array<{ status: string; count: number }>;
  /**
   * Count of Subscription rows that have a `billingProvider` set (i.e.
   * are Stripe-backed) but whose `lastSyncedAt` is still null — per this
   * column's own doc comment in schema.prisma, that combination means
   * "Stripe is the one source that has never actually confirmed this
   * row's state," which is the one unambiguous "suspicious" signal
   * derivable from existing columns without inventing a new staleness
   * threshold or re-deriving Phase 12B's own status/entitlement logic.
   */
  neverSyncedCount: number;
}

export async function getBillingAdminStatus(prisma: PrismaClient): Promise<BillingAdminStatus> {
  const runtime = getRuntimeBilling();

  const [grouped, neverSyncedCount] = await Promise.all([
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.subscription.count({
      where: { billingProvider: { not: null }, lastSyncedAt: null },
    }),
  ]);
  const subscriptionsByStatus = grouped.map((row) => ({
    status: row.status,
    count: row._count._all,
  }));

  if (!runtime.enabled) {
    return {
      enabled: false,
      disabledReason: runtime.reason,
      subscriptionsByStatus,
      neverSyncedCount,
    };
  }
  return {
    enabled: true,
    mode: runtime.config.mode,
    subscriptionsByStatus,
    neverSyncedCount,
  };
}
