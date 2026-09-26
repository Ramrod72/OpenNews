import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Public plan catalog (pricing + feature matrix) — no auth required, nothing here is sensitive. */
export async function GET() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    include: { entitlements: true },
    orderBy: { priceCents: "asc" },
  });

  return NextResponse.json({
    plans: plans.map((p) => ({
      slug: p.slug,
      name: p.name,
      priceCents: p.priceCents,
      billingInterval: p.billingInterval,
      entitlements: Object.fromEntries(
        p.entitlements.map((e) => [
          e.feature,
          { boolValue: e.boolValue, limitValue: e.limitValue },
        ]),
      ),
    })),
  });
}
