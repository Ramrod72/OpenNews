import Link from "next/link";
import { Check } from "lucide-react";
import type { PricingPlanView } from "@/lib/pricing";
import { FeatureStatusTag } from "./FeatureStatusTag";
import { CurrentPlanIndicator } from "./PlanBadge";
import { UpgradeButton } from "./UpgradeButton";

export function PlanCard({
  plan,
  previousPlanName,
  highlighted = false,
}: {
  plan: PricingPlanView;
  previousPlanName: string | null;
  highlighted?: boolean;
}) {
  const price = plan.priceCents === 0 ? "$0" : `$${(plan.priceCents / 100).toFixed(2)}`;

  return (
    <div
      className={`flex flex-col rounded-2xl border p-6 ${
        highlighted ? "border-accent shadow-lg" : "border-border"
      }`}
    >
      <h2 className="text-xs font-bold tracking-wide text-foreground-muted uppercase">
        Veriqen News {plan.name}
      </h2>
      <p className="mt-2 text-3xl font-extrabold">
        {price}
        {plan.priceCents > 0 && (
          <span className="text-sm font-medium text-foreground-muted">/{plan.billingInterval}</span>
        )}
      </p>
      <p className="mb-5 text-xs text-foreground-muted">
        {plan.priceCents === 0 ? "No credit card required" : `Billed ${plan.billingInterval}ly`}
      </p>

      <div className="mb-2">
        {plan.isCurrent ? (
          <CurrentPlanIndicator />
        ) : plan.cta === "signup" ? (
          <Link
            href="/register"
            className="block w-full rounded-lg bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            {plan.priceCents === 0 ? "Sign up free" : "Create a free account"}
          </Link>
        ) : plan.cta === "upgrade" && (plan.slug === "basic" || plan.slug === "pro") ? (
          <UpgradeButton planName={plan.name} planSlug={plan.slug} variant="primary" />
        ) : (
          <p className="text-xs text-foreground-muted">Included at your current tier</p>
        )}
      </div>

      {plan.cta === "signup" && plan.priceCents > 0 && (
        <p className="mb-4 text-xs text-foreground-muted">
          Billing isn&apos;t enabled yet — signing up creates a Free account today.
        </p>
      )}

      {previousPlanName && (
        <p className="mt-3 mb-3 text-sm font-semibold">Everything in {previousPlanName}, plus:</p>
      )}

      <ul className="space-y-2.5 text-sm">
        {plan.highlights.map((highlight) => (
          <li key={highlight.key} className="flex items-start gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <span className="flex-1">{highlight.label}</span>
            <FeatureStatusTag status={highlight.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}
