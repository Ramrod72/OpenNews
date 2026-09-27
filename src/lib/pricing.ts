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
}

/** The account page's plan section: the user's current plan plus their upgrade options. */
export async function getAccountPlanSummary(userId: string): Promise<AccountPlanSummary> {
  const [plans, currentPlan] = await Promise.all([loadActivePlans(), getPlan(userId)]);
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
  };
}

export function formatPrice(priceCents: number, billingInterval: string): string {
  if (priceCents === 0) return "Free";
  return `$${(priceCents / 100).toFixed(2)}/${billingInterval}`;
}
