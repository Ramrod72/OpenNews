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

/**
 * Exported solely so tests can seed a UsageRecord row directly (a single
 * write) instead of looping reserveUsage() dozens of times just to reach a
 * starting count — see test/aiStoryBriefQuotaRace.integration.test.ts.
 * Production code should still always go through reserveUsage/recordUsage.
 */
export function currentPeriodStart(at: Date): Date {
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

export interface UsageReservation {
  /** True only if a unit was actually reserved (count incremented). False means the caller must not proceed — no unit was consumed. */
  reserved: boolean;
  used: number;
  limit: number | null;
}

/**
 * Concurrency-safe quota reservation, added for Phase 11B's AI Story
 * Brief (which must reserve a unit BEFORE a slow provider call, then
 * release it on failure — see releaseUsage below) but generic to any
 * quota-limited feature.
 *
 * `checkUsage()` + `recordUsage()` above are NOT safe for this: they are
 * two separate round-trips, so two concurrent callers can both read
 * `used < limit` as true before either has written, and both then record
 * usage, collectively exceeding the limit. This function closes that gap
 * with the identical concurrency-safe shape persistClaimsForArticle
 * (src/lib/claims/persistClaims.ts) and persistObservationsForArticle
 * already establish for their own per-article caps: the read of the
 * current count and the write that consumes the remaining budget happen
 * inside ONE `prisma.$transaction`, so two concurrent reservations for
 * the SAME (userId, feature, periodStart) cannot both read a stale
 * pre-write count and collectively overshoot the limit — the database
 * serializes the two transactions (SQLite: single writer; Postgres:
 * standard row-level locking on the upsert), so the second transaction's
 * read only commits after the first transaction's write is visible.
 *
 * A `limit === null` (unlimited) feature always reserves successfully
 * without needing the transaction at all — there's no budget to race
 * over. A `limit <= 0` feature (no access) never reserves.
 */
export async function reserveUsage(
  userId: string,
  feature: string,
  at: Date = new Date(),
): Promise<UsageReservation> {
  const limit = await getLimit(userId, feature);

  if (limit === null) {
    await recordUsage(userId, feature, at);
    return { reserved: true, used: 0, limit: null };
  }
  if (limit <= 0) {
    return { reserved: false, used: 0, limit };
  }

  const periodStart = currentPeriodStart(at);
  const reserved = await prisma.$transaction(
    async (tx) => {
      const record = await tx.usageRecord.findUnique({
        where: { userId_feature_periodStart: { userId, feature, periodStart } },
      });
      const used = record?.count ?? 0;
      if (used >= limit) return false;

      if (record) {
        await tx.usageRecord.update({
          where: { id: record.id },
          data: { count: { increment: 1 } },
        });
      } else {
        await tx.usageRecord.create({ data: { userId, feature, periodStart, count: 1 } });
      }
      return true;
    },
    // Generous relative to Prisma's own defaults (maxWait 2s, timeout 5s):
    // under genuine multi-way contention on this one row (several
    // concurrent reservation attempts for the same user+feature+period),
    // SQLite's single-writer model means later transactions legitimately
    // queue behind earlier ones rather than failing — better to wait
    // longer than to abort a transaction that would otherwise have
    // succeeded, which for a QUOTA check would otherwise fail closed in a
    // way indistinguishable from "quota exceeded" to the caller.
    { maxWait: 10_000, timeout: 10_000 },
  );

  const finalRecord = await prisma.usageRecord.findUnique({
    where: { userId_feature_periodStart: { userId, feature, periodStart } },
  });
  return { reserved, used: finalRecord?.count ?? 0, limit };
}

/**
 * Releases (refunds) one previously-reserved unit — call this when a
 * reserved generation ultimately fails (provider error, validation
 * failure) so the failure doesn't permanently cost the user a quota unit.
 * Floors at 0 (never decrements a feature with no recorded usage) and is
 * itself a single atomic update, so a release racing another
 * reserve/release for the same (userId, feature, periodStart) still
 * lands on a consistent final count.
 *
 * Known residual limitation: if the server process crashes between a
 * successful reservation and the call site's own release-on-failure
 * (e.g. mid-provider-call), the reservation is never refunded. This is an
 * accepted, documented tradeoff (the same class of risk any in-process
 * request-scoped cleanup carries) rather than a correctness bug in this
 * function itself.
 */
export async function releaseUsage(
  userId: string,
  feature: string,
  at: Date = new Date(),
): Promise<void> {
  const periodStart = currentPeriodStart(at);
  await prisma.$transaction(
    async (tx) => {
      const record = await tx.usageRecord.findUnique({
        where: { userId_feature_periodStart: { userId, feature, periodStart } },
      });
      if (!record || record.count <= 0) return;
      await tx.usageRecord.update({ where: { id: record.id }, data: { count: { decrement: 1 } } });
    },
    { maxWait: 10_000, timeout: 10_000 },
  );
}
