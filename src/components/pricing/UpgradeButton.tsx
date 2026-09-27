"use client";

import { useState } from "react";

/**
 * The only "upgrade" affordance in the app. It never calls an API and
 * never mutates the account's plan — there's no billing integration yet,
 * so clicking it can only ever explain that, not start a real upgrade.
 * Shared between /pricing and /account so that message is defined once.
 */
export function UpgradeButton({
  planName,
  variant = "outline",
}: {
  planName: string;
  variant?: "primary" | "outline";
}) {
  const [clicked, setClicked] = useState(false);

  if (clicked) {
    return (
      <p className="text-xs text-foreground-muted" role="status">
        Billing isn&apos;t configured yet {"—"} check back soon.
      </p>
    );
  }

  const className =
    variant === "primary"
      ? "w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
      : "rounded-full border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-muted";

  return (
    <button type="button" onClick={() => setClicked(true)} className={className}>
      Upgrade to {planName}
    </button>
  );
}
