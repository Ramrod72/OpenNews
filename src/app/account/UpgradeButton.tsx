"use client";

import { useState } from "react";

export function UpgradeButton({ planName }: { planName: string }) {
  const [clicked, setClicked] = useState(false);

  if (clicked) {
    return (
      <p className="text-xs text-foreground-muted">
        Billing isn&apos;t configured yet {"—"} check back soon.
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setClicked(true)}
      className="rounded-full border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-muted"
    >
      Upgrade to {planName}
    </button>
  );
}
