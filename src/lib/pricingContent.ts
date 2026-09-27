import type { ResolvedEntitlement } from "@/lib/entitlements";

/**
 * Marketing copy and "is this actually built yet" status, kept
 * deliberately separate from the entitlement data itself (which lives in
 * the database, seeded from config/plans.json). This file never asserts
 * whether a plan HAS a feature — that always comes from the real
 * entitlement values passed in below — it only supplies the label and
 * whether the underlying product feature exists yet.
 *
 * "live": the capability genuinely works today, for whoever the
 * entitlement says should have it (e.g. the news feed, the sources page,
 * perspective/source labeling — none of these are plan-gated yet, but
 * they exist and function).
 * "planned": the entitlement is a real, seeded part of the plan (this
 * isn't invented pricing), but no code in the app currently enforces or
 * exposes it — no page reads this feature key via can()/getLimit() yet.
 * Shown honestly rather than silently promised. See ARCHITECTURE.md.
 */
export type FeatureStatus = "live" | "planned";

export interface Highlight {
  /** Stable id for tests/keys — the entitlement feature key, or a synthetic one for baseline copy. */
  key: string;
  label: string;
  status: FeatureStatus;
}

type BooleanToggleEntry = {
  kind: "boolean-toggle";
  key: string;
  whenTrue: { label: string; status: FeatureStatus };
  whenFalse: { label: string; status: FeatureStatus };
  /** Which branch represents the more capable/premium state, for the comparison table's check mark. */
  positiveWhen: "true" | "false";
};

type BooleanPositiveEntry = {
  kind: "boolean-positive";
  key: string;
  label: string;
  status: FeatureStatus;
};

type LimitEntry = {
  kind: "limit";
  key: string;
  /** e.g. "saved stories", "custom topics" — used in "Up to N …" / "Unlimited …" copy. */
  noun: string;
  status: FeatureStatus;
};

type UniversalEntry = {
  kind: "universal";
  key: string;
  label: string;
  status: FeatureStatus;
};

type CatalogEntry = BooleanToggleEntry | BooleanPositiveEntry | LimitEntry | UniversalEntry;

/**
 * Every entry here corresponds to a real column in the Entitlement table
 * (see config/plans.json / prisma/seedPlans.ts) except "standard_feed",
 * which isn't plan-gated at all — every visitor already gets it. Order
 * here is the display priority used when building a plan's highlight
 * list.
 */
const CATALOG: CatalogEntry[] = [
  { kind: "universal", key: "standard_feed", label: "Standard news feed", status: "live" },
  {
    kind: "boolean-toggle",
    key: "ads_enabled",
    whenTrue: { label: "Includes advertising", status: "live" },
    whenFalse: { label: "Ad-free browsing", status: "planned" },
    positiveWhen: "false",
  },
  {
    kind: "boolean-toggle",
    key: "search_full",
    whenTrue: { label: "Full search", status: "planned" },
    whenFalse: { label: "Basic search", status: "live" },
    positiveWhen: "true",
  },
  { kind: "limit", key: "saved_stories_limit", noun: "saved stories", status: "planned" },
  { kind: "limit", key: "custom_topics_limit", noun: "custom topics", status: "planned" },
  {
    kind: "boolean-toggle",
    key: "coverage_comparison_full",
    whenTrue: { label: "Full coverage comparison", status: "planned" },
    whenFalse: { label: "Basic coverage comparison", status: "planned" },
    positiveWhen: "true",
  },
  {
    kind: "boolean-toggle",
    key: "source_profiles_detailed",
    whenTrue: { label: "Detailed source profiles", status: "planned" },
    whenFalse: { label: "Basic source information", status: "live" },
    positiveWhen: "true",
  },
  {
    kind: "boolean-toggle",
    key: "source_bias_detailed",
    whenTrue: { label: "Detailed source bias insights", status: "planned" },
    whenFalse: { label: "Basic transparency information", status: "live" },
    positiveWhen: "true",
  },
  {
    kind: "boolean-positive",
    key: "provenance_full",
    label: "Full source trails & transparency",
    status: "planned",
  },
  { kind: "limit", key: "notifications_limit", noun: "notifications", status: "planned" },
  {
    kind: "boolean-positive",
    key: "filtering_additional",
    label: "Additional filtering options",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "filtering_advanced",
    label: "Advanced filtering",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "story_history_timeline",
    label: "Story history timeline",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "advanced_alerts",
    label: "Advanced alerts",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "ai_summaries",
    label: "AI story summaries",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "cross_source_synthesis",
    label: "Cross-source synthesis",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "claim_comparison",
    label: "Claim comparison",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "historical_source_analysis",
    label: "Historical source analysis",
    status: "planned",
  },
  { kind: "boolean-positive", key: "research_tools", label: "Research tools", status: "planned" },
  {
    kind: "boolean-positive",
    key: "export_enabled",
    label: "Export capabilities",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "source_dependency_analysis",
    label: "Source dependency analysis",
    status: "planned",
  },
  {
    kind: "boolean-positive",
    key: "provenance_visualization_enhanced",
    label: "Enhanced provenance visualization",
    status: "planned",
  },
  { kind: "limit", key: "ai_monthly_quota", noun: "AI actions per month", status: "planned" },
];

function formatLimitLabel(noun: string, limitValue: number | null): string | null {
  if (limitValue === null) return `Unlimited ${noun}`;
  if (limitValue <= 0) return null;
  return `Up to ${limitValue} ${noun}`;
}

/**
 * limitValue is meaningfully `null` (unlimited) as distinct from a missing
 * entitlement row (treated as 0 / no access) — `?? 0` would wrongly
 * collapse the two, so this looks up presence explicitly.
 */
function limitValueOf(
  entitlements: Record<string, ResolvedEntitlement>,
  key: string,
): number | null {
  const entitlement = entitlements[key];
  return entitlement ? entitlement.limitValue : 0;
}

/** The bullet this entry would show for a plan with these entitlements, or null if it doesn't apply. */
function resolveEntry(
  entry: CatalogEntry,
  entitlements: Record<string, ResolvedEntitlement>,
): Highlight | null {
  switch (entry.kind) {
    case "universal":
      return { key: entry.key, label: entry.label, status: entry.status };
    case "boolean-toggle": {
      const branch = entitlements[entry.key]?.boolValue ? entry.whenTrue : entry.whenFalse;
      return { key: entry.key, label: branch.label, status: branch.status };
    }
    case "boolean-positive": {
      if (!entitlements[entry.key]?.boolValue) return null;
      return { key: entry.key, label: entry.label, status: entry.status };
    }
    case "limit": {
      const label = formatLimitLabel(entry.noun, limitValueOf(entitlements, entry.key));
      if (!label) return null;
      return { key: entry.key, label, status: entry.status };
    }
  }
}

/**
 * The highlights NEW at this plan tier compared to the next-cheapest
 * plan (or all applicable highlights, for the cheapest/first plan).
 * Driven entirely by the actual entitlement values passed in — nothing
 * here hardcodes "Basic gets X" by plan slug or name.
 */
export function buildNewHighlights(
  entitlements: Record<string, ResolvedEntitlement>,
  previousEntitlements: Record<string, ResolvedEntitlement> | null,
): Highlight[] {
  const highlights: Highlight[] = [];
  for (const entry of CATALOG) {
    const current = resolveEntry(entry, entitlements);
    if (!current) continue;
    if (previousEntitlements) {
      const previous = resolveEntry(entry, previousEntitlements);
      if (previous && previous.label === current.label) continue;
    }
    highlights.push(current);
  }
  return highlights;
}

export interface ComparisonRow {
  key: string;
  /** Neutral, plan-independent row title for the comparison table. */
  title: string;
  cells: Array<{ included: boolean; text: string | null; status: FeatureStatus }>;
}

/** One row per catalog entry, evaluated against each plan's entitlements in order. */
export function buildComparisonRows(
  entitlementsByPlan: Array<Record<string, ResolvedEntitlement>>,
): ComparisonRow[] {
  return CATALOG.map((entry) => {
    const title = rowTitle(entry);
    const cells = entitlementsByPlan.map((entitlements) => {
      const resolved = resolveEntry(entry, entitlements);
      if (!resolved) return { included: false, text: null, status: fallbackStatus(entry) };
      return {
        included: isIncluded(entry, entitlements),
        text: resolved.label,
        status: resolved.status,
      };
    });
    return { key: entry.key, title, cells };
  });
}

/** Whether this plan is on the more-capable side of the entry (drives the table's check mark). */
function isIncluded(
  entry: CatalogEntry,
  entitlements: Record<string, ResolvedEntitlement>,
): boolean {
  switch (entry.kind) {
    case "universal":
      return true;
    case "boolean-toggle": {
      const value = Boolean(entitlements[entry.key]?.boolValue);
      return entry.positiveWhen === "true" ? value : !value;
    }
    case "boolean-positive":
      return Boolean(entitlements[entry.key]?.boolValue);
    case "limit":
      return formatLimitLabel(entry.noun, limitValueOf(entitlements, entry.key)) !== null;
  }
}

function fallbackStatus(entry: CatalogEntry): FeatureStatus {
  return entry.kind === "boolean-toggle"
    ? entry.positiveWhen === "true"
      ? entry.whenTrue.status
      : entry.whenFalse.status
    : entry.status;
}

function rowTitle(entry: CatalogEntry): string {
  switch (entry.kind) {
    case "universal":
      return entry.label;
    case "boolean-toggle":
      // Neutral row title: the phrasing for the plan's more-capable side.
      return entry.positiveWhen === "true" ? entry.whenTrue.label : entry.whenFalse.label;
    case "boolean-positive":
      return entry.label;
    case "limit":
      return entry.noun.replace(/^./, (c) => c.toUpperCase());
  }
}
