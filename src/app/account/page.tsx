import { redirect } from "next/navigation";
import Link from "next/link";
import { UserCircle } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getAccountPlanSummary } from "@/lib/pricing";
import { absoluteTime } from "@/lib/format";
import { PlanBadge } from "@/components/pricing/PlanBadge";
import { FeatureStatusTag } from "@/components/pricing/FeatureStatusTag";
import { UpgradeButton } from "@/components/pricing/UpgradeButton";
import { LogoutButton } from "./LogoutButton";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const summary = await getAccountPlanSummary(user.id);
  const upgradeOptions = summary.otherPlans.filter((p) => p.cta === "upgrade");

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 flex items-center gap-3">
        <UserCircle size={32} className="text-accent" />
        <div>
          <h1 className="text-xl font-extrabold">{user.displayName || user.email}</h1>
          <p className="text-sm text-foreground-muted">{user.email}</p>
        </div>
      </div>

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

        {summary.aiUsage && (
          <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
            AI usage this month: {summary.aiUsage.used} of {summary.aiUsage.limit}
          </p>
        )}

        <p className="mb-2 text-sm font-semibold">What&apos;s included</p>
        <ul className="space-y-2 text-sm">
          {summary.highlights.map((highlight) => (
            <li key={highlight.key} className="flex items-start justify-between gap-2">
              <span>{highlight.label}</span>
              <FeatureStatusTag status={highlight.status} />
            </li>
          ))}
        </ul>
      </div>

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
                <UpgradeButton planName={p.name} />
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
