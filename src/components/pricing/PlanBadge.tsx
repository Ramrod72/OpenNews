const PLAN_STYLES: Record<string, string> = {
  free: "bg-surface-muted text-foreground-muted",
  basic: "bg-accent/10 text-accent",
  pro: "bg-accent text-accent-foreground",
};

/** The plan-name pill used on cards, the comparison table, and the account page. */
export function PlanBadge({ slug, name }: { slug: string; name: string }) {
  const style = PLAN_STYLES[slug] ?? "bg-surface-muted text-foreground-muted";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold tracking-wide uppercase ${style}`}
    >
      {name}
    </span>
  );
}

/** "Current plan" indicator — text-based, not color-only, so it reads fine without the accent color. */
export function CurrentPlanIndicator() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent px-3 py-1.5 text-xs font-semibold text-accent">
      ✓ Current plan
    </span>
  );
}
