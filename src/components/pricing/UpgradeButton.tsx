"use client";

import { useState } from "react";
import { CSRF_HEADER } from "@/lib/auth/consumer/csrf";

/**
 * Starts a first-purchase Stripe Checkout for `planSlug` ("basic" | "pro")
 * and redirects the browser to Stripe's hosted page. Never itself grants
 * anything — the actual entitlement change only ever happens once a
 * verified webhook synchronizes real Stripe state (see
 * src/lib/billing/webhookSync.ts and this file's own account-page
 * sibling, ManageBillingButton.tsx, for the same non-trusting pattern).
 * If billing isn't configured on this deployment, the API call itself
 * returns 503 and this button surfaces that as a plain message rather
 * than crashing.
 */
export function UpgradeButton({
  planName,
  planSlug,
  variant = "outline",
}: {
  planName: string;
  planSlug: "basic" | "pro";
  variant?: "primary" | "outline";
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const className =
    variant === "primary"
      ? "w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60"
      : "rounded-full border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60";

  async function handleClick() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ plan: planSlug }),
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) {
        setErrorMessage(data?.error ?? "Something went wrong. Please try again.");
        setState("error");
        return;
      }
      window.location.href = data.url;
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setState("error");
    }
  }

  if (state === "error") {
    return (
      <p className="text-xs text-breaking" role="alert">
        {errorMessage}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === "loading"}
      className={className}
    >
      {state === "loading" ? "Redirecting…" : `Upgrade to ${planName}`}
    </button>
  );
}
