import type { PrismaClient } from "@prisma/client";
import plans from "../config/plans.json";

type PlanEntitlements = Record<string, boolean | number | null>;

interface PlanConfig {
  slug: string;
  name: string;
  priceCents: number;
  billingInterval: string;
  entitlements: PlanEntitlements;
}

/**
 * Seeds the Free/Basic/Pro plans and their entitlement matrix from
 * config/plans.json — the same "config as data" convention used for
 * categories/sources, so pricing/feature changes don't require an
 * application redeploy, only a reseed (`npm run db:seed`).
 *
 * Each entitlement value's JSON type decides how it's stored: a boolean
 * becomes Entitlement.boolValue (an on/off feature), a number or null
 * becomes Entitlement.limitValue (a quota; null means unlimited).
 */
export async function seedPlans(prisma: PrismaClient): Promise<void> {
  let entitlementCount = 0;

  for (const plan of plans as PlanConfig[]) {
    const planRow = await prisma.plan.upsert({
      where: { slug: plan.slug },
      create: {
        slug: plan.slug,
        name: plan.name,
        priceCents: plan.priceCents,
        billingInterval: plan.billingInterval,
      },
      update: {
        name: plan.name,
        priceCents: plan.priceCents,
        billingInterval: plan.billingInterval,
      },
    });

    for (const [feature, value] of Object.entries(plan.entitlements)) {
      const isBoolean = typeof value === "boolean";
      await prisma.entitlement.upsert({
        where: { planId_feature: { planId: planRow.id, feature } },
        create: {
          planId: planRow.id,
          feature,
          boolValue: isBoolean ? value : null,
          limitValue: isBoolean ? null : value,
        },
        update: {
          boolValue: isBoolean ? value : null,
          limitValue: isBoolean ? null : value,
        },
      });
      entitlementCount += 1;
    }
  }

  console.log(`Synced ${plans.length} plans and ${entitlementCount} entitlements.`);
}
