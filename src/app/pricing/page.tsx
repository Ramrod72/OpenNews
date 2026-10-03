import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getPricingView } from "@/lib/pricing";
import { getBillingConfig } from "@/lib/billing/config";
import { getSiteUrl } from "@/lib/siteUrl";
import { PlanCard } from "@/components/pricing/PlanCard";
import { FeatureComparisonTable } from "@/components/pricing/FeatureComparisonTable";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Compare Veriqen News's Free, Basic, and Pro plans — ad-free reading, saved stories, and deeper coverage-comparison and AI story-brief features.",
  alternates: { canonical: `${getSiteUrl()}/pricing` },
};

export default async function PricingPage() {
  const user = await getCurrentUser();
  const { plans, comparisonRows } = await getPricingView(user?.id ?? null);
  const billingEnabled = getBillingConfig().enabled;

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
        {billingEnabled ? (
          <>
            Basic and Pro are billed monthly through Stripe. You can cancel, switch plans, or update
            your card anytime from your account page.
          </>
        ) : (
          <>Veriqen News&apos;s subscription billing isn&apos;t enabled on this deployment yet.</>
        )}{" "}
        Features tagged <strong className="font-semibold text-foreground">Coming soon</strong>{" "}
        describe what each plan will include — they&apos;re part of the real plan definition, not a
        promise we can&apos;t back up, but they aren&apos;t live in the app yet. Everything else
        listed already works today.
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
          {billingEnabled ? (
            <>
              Registering always creates a Free account. Upgrading redirects you to Stripe&apos;s
              secure checkout — Veriqen News never sees or stores your card details. Clicking
              &quot;Back to Veriqen News&quot; or landing back on this site doesn&apos;t change your
              plan by itself; your account only updates once Stripe confirms the subscription, which
              is usually immediate.
            </>
          ) : (
            <>
              Registering always creates a Free account — there&apos;s no checkout flow on this
              deployment yet, and no button on this page or your account page can change your plan
              or charge you anything.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
