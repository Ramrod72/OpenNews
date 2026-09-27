import { Clock } from "lucide-react";
import type { FeatureStatus } from "@/lib/pricingContent";

/**
 * Marks a feature that's part of a plan's definition but not actually
 * built/enforced yet. Icon + text, not color alone, so the distinction
 * survives grayscale/colorblind viewing (see accessibility notes in the
 * Phase 4 PR description).
 */
export function FeatureStatusTag({ status }: { status: FeatureStatus }) {
  if (status === "live") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-foreground-muted">
      <Clock size={11} aria-hidden />
      Coming soon
    </span>
  );
}
