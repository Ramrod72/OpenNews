import { redirect } from "next/navigation";
import Link from "next/link";
import { UserCircle } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getAccountPlanSummary } from "@/lib/pricing";
import { absoluteTime } from "@/lib/format";
import { PlanBadge } from "@/components/pricing/PlanBadge";
import { FeatureStatusTag } from "@/components/pricing/FeatureStatusTag";
import { UpgradeButton } from "@/components/pricing/UpgradeButton";
import { ManageBillingButton } from "@/components/pricing/ManageBillingButton";
import { isPaidPlanSlug } from "@/lib/billing/planMapping";
import { LogoutButton } from "./LogoutButton";
import { AppearanceSection } from "./AppearanceSection";

export const metadata = { title: "Account", robots: { index: false, follow: false } };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const summary = await getAccountPlanSummary(user.id);
  const upgradeOptions = summary.otherPlans.filter(
    (p): p is typeof p & { slug: "basic" | "pro" } => p.cta === "upgrade" && isPaidPlanSlug(p.slug),
  );
  const checkoutParam = (await searchParams).checkout;

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 flex items-center gap-3">
        <UserCircle size={32} className="text-accent" />
        <div>
          <h1 className="text-xl font-extrabold">{user.displayName || user.email}</h1>
          <p className="text-sm text-foreground-muted">{user.email}</p>
        </div>
      </div>

      {checkoutParam === "success" && (
        <div
          className="mb-4 rounded-xl border border-border bg-surface-muted p-3 text-sm"
          role="status"
        >
          Thanks! We&apos;re confirming your subscription with Stripe — this page will reflect your
          new plan as soon as that finishes, usually within a few seconds. If your plan below still
          says Free after refreshing, contact support.
        </div>
      )}
      {checkoutParam === "canceled" && (
        <div
          className="mb-4 rounded-xl border border-border bg-surface-muted p-3 text-sm text-foreground-muted"
          role="status"
        >
          Checkout was canceled — you weren&apos;t charged, and your plan is unchanged.
        </div>
      )}

      {summary.billing.isPastDue && (
        <div
          className="mb-4 rounded-xl border border-breaking/50 bg-breaking/10 p-3 text-sm"
          role="alert"
        >
          <p className="mb-2 font-semibold">There&apos;s a problem with your payment.</p>
          <p className="mb-2 text-foreground-muted">
            You still have full access while we retry your payment method. Update your card via
            Manage Billing to avoid losing access.
          </p>
          <ManageBillingButton />
        </div>
      )}

      <div className="mb-6 rounded-xl border border-border p-4">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-foreground-muted uppercase">
              Current plan
            </p>
            <PlanBadge slug={summary.slug} name={summary.name} />
            <p className="mt-2 text-xs text-foreground-muted">
              Member since {absoluteTime(user.createdAt)}
            </p>
          </div>
          <LogoutButton />
        </div>

        {summary.billing.cancelAtPeriodEnd && summary.billing.currentPeriodEnd && (
          <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
            Your plan is scheduled to end on {absoluteTime(summary.billing.currentPeriodEnd)}. You
            keep full access until then — reactivate anytime before that date via Manage Billing.
          </p>
        )}

        {summary.aiUsage && (
          <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
            AI usage this month: {summary.aiUsage.used} of {summary.aiUsage.limit}
          </p>
        )}

        <p className="mb-2 text-sm font-semibold">What&apos;s included</p>
        <ul className="mb-3 space-y-2 text-sm">
          {summary.highlights.map((highlight) => (
            <li key={highlight.key} className="flex items-start justify-between gap-2">
              <span>{highlight.label}</span>
              <FeatureStatusTag status={highlight.status} />
            </li>
          ))}
        </ul>

        {summary.billing.hasBillingAccount && <ManageBillingButton />}
      </div>

      <AppearanceSection />

      {upgradeOptions.length > 0 && (
        <div className="rounded-xl border border-border p-4">
          <p className="mb-3 font-bold">Upgrade options</p>
          <ul className="space-y-3">
            {upgradeOptions.map((p) => (
              <li key={p.slug} className="flex items-center justify-between gap-3">
                <div>
                  <PlanBadge slug={p.slug} name={p.name} />
                  <p className="mt-1 text-xs text-foreground-muted">
                    {p.priceCents === 0
                      ? "Free"
                      : `$${(p.priceCents / 100).toFixed(2)}/${p.billingInterval}`}
                  </p>
                </div>
                <UpgradeButton planName={p.name} planSlug={p.slug} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-6 text-center text-xs text-foreground-muted">
        See the full breakdown on the{" "}
        <Link href="/pricing" className="font-medium text-accent hover:underline">
          pricing page
        </Link>
        .
      </p>
    </div>
  );
}
