import { prisma } from "@/lib/db";
import type { Entitlement, Plan } from "@prisma/client";

/**
 * The single place feature gating is decided. Application code should
 * call can()/getLimit()/checkUsage() rather than inspecting a user's plan
 * slug directly (e.g. `if (user.plan === "pro")`) — that keeps every
 * feature's rule in one seedable table (config/plans.json →
 * prisma/seedPlans.ts) instead of scattered through the codebase.
 *
 * Anonymous visitors (userId = null) resolve to the Free plan, per the
 * product requirement that anonymous browsing behaves like a Free account
 * for public features.
 *
 * Missing entitlement rows fail CLOSED: an unrecognized feature key
 * resolves to boolValue=false / limitValue=0 (no access) rather than
 * throwing or defaulting to unlimited. A typo'd feature key should never
 * accidentally grant access.
 */

export interface ResolvedEntitlement {
  boolValue: boolean | null;
  limitValue: number | null;
}

export interface ResolvedPlan {
  slug: string;
  name: string;
  priceCents: number;
  entitlements: Record<string, ResolvedEntitlement>;
}

export interface UsageCheck {
  allowed: boolean;
  used: number;
  /** null means unlimited. */
  limit: number | null;
}

const FREE_PLAN_SLUG = "free";

type PlanWithEntitlements = Plan & { entitlements: Entitlement[] };

function toResolvedPlan(plan: PlanWithEntitlements): ResolvedPlan {
  const entitlements: Record<string, ResolvedEntitlement> = {};
  for (const e of plan.entitlements) {
    entitlements[e.feature] = { boolValue: e.boolValue, limitValue: e.limitValue };
  }
  return { slug: plan.slug, name: plan.name, priceCents: plan.priceCents, entitlements };
}

async function loadFreePlan(): Promise<PlanWithEntitlements> {
  const plan = await prisma.plan.findUnique({
    where: { slug: FREE_PLAN_SLUG },
    include: { entitlements: true },
  });
  if (!plan) {
    throw new Error(
      `The "${FREE_PLAN_SLUG}" plan is not seeded. Run \`npm run db:seed\` (see prisma/seedPlans.ts).`,
    );
  }
  return plan;
}

/**
 * Resolves the plan currently in effect for a user, or the Free plan for
 * an anonymous visitor (userId = null). If a user somehow has no active
 * subscription (shouldn't happen — registration always creates one), this
 * also falls back to Free rather than throwing, so a data inconsistency
 * degrades to the safe default instead of breaking the page.
 */
export async function getPlan(userId: string | null): Promise<ResolvedPlan> {
  if (userId) {
    const subscription = await prisma.subscription.findFirst({
      where: { userId, status: "active" },
      orderBy: { createdAt: "desc" },
      include: { plan: { include: { entitlements: true } } },
    });
    if (subscription) return toResolvedPlan(subscription.plan);
  }
  return toResolvedPlan(await loadFreePlan());
}

export async function getEntitlements(
  userId: string | null,
): Promise<Record<string, ResolvedEntitlement>> {
  return (await getPlan(userId)).entitlements;
}

/** Boolean on/off feature check. */
export async function can(userId: string | null, feature: string): Promise<boolean> {
  const entitlements = await getEntitlements(userId);
  return entitlements[feature]?.boolValue ?? false;
}

/** Numeric quota; null means unlimited, 0 means no access. */
export async function getLimit(userId: string | null, feature: string): Promise<number | null> {
  const entitlements = await getEntitlements(userId);
  const entitlement = entitlements[feature];
  if (!entitlement) return 0;
  return entitlement.limitValue;
}

function currentPeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Checks a user's consumption of a quota-limited feature against their
 * plan's limit for the current (calendar-month) period. Anonymous users
 * can't have tracked usage (no account to attach it to), so this only
 * ever reports their plan's raw limit with used=0.
 */
export async function checkUsage(
  userId: string | null,
  feature: string,
  at: Date = new Date(),
): Promise<UsageCheck> {
  const limit = await getLimit(userId, feature);

  if (!userId) {
    return { allowed: limit === null || limit > 0, used: 0, limit };
  }
  if (limit === null) {
    return { allowed: true, used: 0, limit: null };
  }

  const periodStart = currentPeriodStart(at);
  const record = await prisma.usageRecord.findUnique({
    where: { userId_feature_periodStart: { userId, feature, periodStart } },
  });
  const used = record?.count ?? 0;

  return { allowed: used < limit, used, limit };
}

/** Records one use of a quota-limited feature for the current period. */
export async function recordUsage(
  userId: string,
  feature: string,
  at: Date = new Date(),
): Promise<void> {
  const periodStart = currentPeriodStart(at);
  await prisma.usageRecord.upsert({
    where: { userId_feature_periodStart: { userId, feature, periodStart } },
    create: { userId, feature, periodStart, count: 1 },
    update: { count: { increment: 1 } },
  });
}
