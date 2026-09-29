"use client";

import { useState } from "react";
import { CSRF_HEADER } from "@/lib/auth/consumer/csrf";

/**
 * The one door into Stripe's hosted Customer Portal — card updates,
 * cancellation, reactivation, invoices, billing history, AND paid-plan
 * switching (Basic<->Pro) all happen there, never in bespoke Veriqen UI
 * (see ARCHITECTURE.md's Phase 12B section for why). The customer id is
 * resolved server-side from the authenticated session, never passed by
 * this component.
 */
export function ManageBillingButton() {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClick() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { [CSRF_HEADER]: "1" },
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) {
        setErrorMessage(data?.error ?? "Billing management is temporarily unavailable.");
        setState("error");
        return;
      }
      window.location.href = data.url;
    } catch {
      setErrorMessage("Billing management is temporarily unavailable.");
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
      className="rounded-full border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60"
    >
      {state === "loading" ? "Loading…" : "Manage billing"}
    </button>
  );
}
