import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getPricingView } from "@/lib/pricing";
import { PlanCard } from "@/components/pricing/PlanCard";
import { FeatureComparisonTable } from "@/components/pricing/FeatureComparisonTable";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  const user = await getCurrentUser();
  const { plans, comparisonRows } = await getPricingView(user?.id ?? null);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mx-auto mb-10 max-w-2xl text-center">
        <h1 className="text-3xl font-extrabold tracking-tight">Plans for every kind of reader</h1>
        <p className="mt-3 text-foreground-muted">
          Start free, no credit card required. Upgrade later for a deeper, ad-free view of how
          stories are covered across sources.
        </p>
      </div>

      <div
        className="mb-4 rounded-xl border border-border bg-surface-muted p-4 text-sm text-foreground-muted"
        role="note"
      >
        Veriqen&apos;s subscription billing isn&apos;t enabled yet. Features tagged{" "}
        <strong className="font-semibold text-foreground">Coming soon</strong> describe what each
        plan will include — they&apos;re part of the real plan definition, not a promise we
        can&apos;t back up, but they aren&apos;t live in the app yet. Everything else listed already
        works today.
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {plans.map((plan, index) => (
          <PlanCard
            key={plan.slug}
            plan={plan}
            previousPlanName={index > 0 ? plans[index - 1].name : null}
            highlighted={plan.slug === "basic"}
          />
        ))}
      </div>

      <div className="mt-14">
        <h2 className="mb-4 text-xl font-bold">Compare every feature</h2>
        <FeatureComparisonTable planNames={plans.map((p) => p.name)} rows={comparisonRows} />
      </div>

      <div className="mt-10 rounded-xl border border-border p-5 text-sm text-foreground-muted">
        <h2 className="mb-2 font-semibold text-foreground">Billing</h2>
        <p>
          Registering always creates a Free account — there&apos;s no checkout flow yet, and no
          button on this page or your account page can change your plan or charge you anything.
          We&apos;ll announce it here when paid plans are actually available to buy.
        </p>
      </div>
    </div>
  );
}
