import type { Entitlement, Plan } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkUsage, getPlan, type ResolvedEntitlement, type UsageCheck } from "@/lib/entitlements";
import {
  buildComparisonRows,
  buildNewHighlights,
  type ComparisonRow,
  type Highlight,
} from "@/lib/pricingContent";

/**
 * Data layer for the pricing page and the account page's plan summary.
 * Both read plans/entitlements straight from the database (seeded from
 * config/plans.json) — nothing here hardcodes a plan's price or feature
 * set. This mirrors the getCurrentUser()/session.ts split from consumer
 * auth: no next/headers import here, so it's testable with a real Prisma
 * database and no request-scope mocking.
 */

export type PlanCta = "signup" | "current" | "upgrade" | "lower-tier";

export interface PricingPlanView {
  slug: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  isCurrent: boolean;
  cta: PlanCta;
  /** Highlights new at this tier vs. the next-cheapest plan (all of them, for the cheapest plan). */
  highlights: Highlight[];
}

export interface PricingView {
  plans: PricingPlanView[];
  comparisonRows: ComparisonRow[];
  /** null for an anonymous visitor — there's no "current plan" until they have an account. */
  currentPlanSlug: string | null;
}

type PlanWithEntitlements = Plan & { entitlements: Entitlement[] };

function toEntitlementsMap(plan: PlanWithEntitlements): Record<string, ResolvedEntitlement> {
  const map: Record<string, ResolvedEntitlement> = {};
  for (const e of plan.entitlements) {
    map[e.feature] = { boolValue: e.boolValue, limitValue: e.limitValue };
  }
  return map;
}

async function loadActivePlans(): Promise<PlanWithEntitlements[]> {
  return prisma.plan.findMany({
    where: { isActive: true },
    include: { entitlements: true },
    orderBy: { priceCents: "asc" },
  });
}

export async function getPricingView(userId: string | null): Promise<PricingView> {
  const [plans, currentPlan] = await Promise.all([loadActivePlans(), getPlan(userId)]);
  const entitlementMaps = plans.map(toEntitlementsMap);

  const planViews: PricingPlanView[] = plans.map((plan, index) => {
    const entitlements = entitlementMaps[index];
    const previous = index > 0 ? entitlementMaps[index - 1] : null;
    const isCurrent = userId !== null && plan.slug === currentPlan.slug;

    let cta: PlanCta;
    if (userId === null) {
      cta = "signup";
    } else if (isCurrent) {
      cta = "current";
    } else if (plan.priceCents > currentPlan.priceCents) {
      cta = "upgrade";
    } else {
      cta = "lower-tier";
    }

    return {
      slug: plan.slug,
      name: plan.name,
      priceCents: plan.priceCents,
      billingInterval: plan.billingInterval,
      isCurrent,
      cta,
      highlights: buildNewHighlights(entitlements, previous),
    };
  });

  return {
    plans: planViews,
    comparisonRows: buildComparisonRows(entitlementMaps),
    currentPlanSlug: userId !== null ? currentPlan.slug : null,
  };
}

/**
 * Raw billing state for the account page — deliberately read directly
 * from the Subscription/User rows rather than through getPlan(), which
 * only ever answers "what plan applies right now" and would silently
 * discard exactly the states this view needs to SHOW (e.g. a canceled
 * subscription's own past plan/period, or a past_due status the account
 * page displays as a payment-problem banner even though — per policy —
 * it currently still grants access). Never calls Stripe directly; this
 * is purely a read of whatever a verified webhook already synchronized
 * (see src/lib/billing/webhookSync.ts).
 */
export interface BillingStatusView {
  /** True once the user has ever completed Checkout (a Stripe customer id is on file), regardless of current status. */
  hasBillingAccount: boolean;
  /** Stripe's own status string (or "active" for a never-paid Free row), null only if the user somehow has no Subscription row at all. */
  status: string | null;
  isPastDue: boolean;
  isCanceled: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
}

async function getBillingStatus(userId: string): Promise<BillingStatusView> {
  const [user, subscription] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.subscription.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    hasBillingAccount: Boolean(user?.externalCustomerId),
    status: subscription?.status ?? null,
    isPastDue: subscription?.status === "past_due",
    isCanceled: subscription?.status === "canceled",
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
  };
}

export interface AccountPlanSummary {
  slug: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  /** Every highlight this plan includes (not just what's new vs. a lower tier). */
  highlights: Highlight[];
  /** Only meaningful for a plan with a non-zero, non-unlimited AI quota (currently Pro). */
  aiUsage: UsageCheck | null;
  otherPlans: PricingPlanView[];
  billing: BillingStatusView;
}

/** The account page's plan section: the user's current plan plus their upgrade options. */
export async function getAccountPlanSummary(userId: string): Promise<AccountPlanSummary> {
  const [plans, currentPlan, billing] = await Promise.all([
    loadActivePlans(),
    getPlan(userId),
    getBillingStatus(userId),
  ]);
  const entitlementMaps = plans.map(toEntitlementsMap);

  const planViews: PricingPlanView[] = plans.map((plan, index) => {
    const entitlements = entitlementMaps[index];
    const isCurrent = plan.slug === currentPlan.slug;
    const cta: PlanCta = isCurrent
      ? "current"
      : plan.priceCents > currentPlan.priceCents
        ? "upgrade"
        : "lower-tier";
    return {
      slug: plan.slug,
      name: plan.name,
      priceCents: plan.priceCents,
      billingInterval: plan.billingInterval,
      isCurrent,
      cta,
      highlights: buildNewHighlights(entitlements, null),
    };
  });

  const current = planViews.find((p) => p.isCurrent) ?? planViews[0];

  // limitValue is meaningfully `null` for an unlimited quota, distinct from
  // a missing entitlement row (no access) — `?.limitValue ?? 0` would wrongly
  // collapse the two and hide the AI usage section for a hypothetical
  // unlimited-quota plan, so presence and value are checked separately.
  const aiEntitlement = currentPlan.entitlements.ai_monthly_quota;
  const aiQuotaLimit = aiEntitlement ? aiEntitlement.limitValue : 0;
  const hasAiQuota = aiQuotaLimit === null || aiQuotaLimit > 0;

  return {
    slug: current.slug,
    name: current.name,
    priceCents: current.priceCents,
    billingInterval: current.billingInterval,
    highlights: current.highlights,
    aiUsage: hasAiQuota ? await checkUsage(userId, "ai_monthly_quota") : null,
    otherPlans: planViews.filter((p) => !p.isCurrent),
    billing,
  };
}

export function formatPrice(priceCents: number, billingInterval: string): string {
  if (priceCents === 0) return "Free";
  return `$${(priceCents / 100).toFixed(2)}/${billingInterval}`;
}
