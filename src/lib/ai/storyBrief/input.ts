import type { CoverageComparisonView } from "@/lib/coverageComparisonView";
import type { StoryIntelligenceView } from "@/lib/storyIntelligenceView";

/**
 * Phase 11B's AI input boundary. Built ENTIRELY from the two already-safe,
 * already-bounded view models Phases 9 and 10 produce for a Pro viewer
 * (StoryIntelligenceView, CoverageComparisonView — CoverageComparisonView
 * itself embeds the headline comparison) — never from a raw Prisma model,
 * never by independently re-querying Claim/ProvenanceObservation rows.
 * The AI can never know more than these two view models already expose,
 * which is the structural guarantee that keeps it from becoming a second,
 * independent source of truth (see this phase's own top-level doc
 * comment in ARCHITECTURE.md).
 *
 * Every item below carries an ephemeral `ref` string built fresh for this
 * one request (see buildReferenceCatalog) — never a database id, never
 * stable across requests. These are the ONLY strings a model output's
 * refs[] may ever cite; server-side validation (storyBrief/schema.ts)
 * rejects anything else.
 */

export const MAX_CLAIM_GROUPS_FOR_AI = 10;
export const MAX_SOURCE_GROUPS_FOR_AI = 5;
export const MAX_HEADLINES_FOR_AI = 10;
/** Each claim-group / headline text item, already capped at this length upstream by Phase 10 — re-asserted here defensively. */
export const MAX_ITEM_TEXT_CHARS = 200;

export interface AiInputClaimGroup {
  ref: string;
  kind: "NUMERICAL_ASSERTION" | "ATTRIBUTED_STATEMENT";
  text: string;
  articleCount: number;
  publisherCount: number;
  numericUnit?: string;
  numericValue?: number;
  numericQualifier?: string;
  /** refs into `sourceGroups` below — never a raw entity name duplicated separately from its ref. */
  sourceOverlapRefs: string[];
}

export interface AiInputSourceGroup {
  ref: string;
  entityName: string;
}

export interface AiInputHeadline {
  ref: string;
  title: string;
  publisherName: string;
  perspective: "reporting" | "analysis" | "opinion";
}

export interface AiStoryBriefInput {
  headline: string;
  articleCount: number;
  publisherCount: number;
  notDetectedCount: number;
  originalReportingCount: number;
  claimGroups: AiInputClaimGroup[];
  sourceGroups: AiInputSourceGroup[];
  headlines: AiInputHeadline[];
  sharedHeadlineEntities: string[];
  limitationsNote: string;
}

/** The closed set of ref strings a model output is ever allowed to cite — built once per request from the exact input above. */
export function collectValidReferences(input: AiStoryBriefInput): Set<string> {
  const refs = new Set<string>();
  for (const g of input.claimGroups) refs.add(g.ref);
  for (const s of input.sourceGroups) refs.add(s.ref);
  for (const h of input.headlines) refs.add(h.ref);
  return refs;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Builds the bounded AI input from a headline (Coverage-Comparison-only)
 * fixture, or from the story-cluster's title plus both safe view models.
 * Both view models MUST already be the full (Pro-shaped) result for the
 * requesting user — this function does not itself perform any
 * entitlement check; the caller (storyBrief/generate.ts) only reaches
 * this after confirming the viewer has cross_source_synthesis, at which
 * point the same viewer is by definition already entitled to
 * coverage_comparison_full and claim_comparison, so requesting the full
 * view for them is not a privilege escalation.
 */
export function buildAiStoryBriefInput(params: {
  headline: string;
  coverage: CoverageComparisonView;
  intelligence: StoryIntelligenceView | null;
}): AiStoryBriefInput {
  const { coverage, intelligence } = params;

  const sourceGroupRefByName = new Map<string, string>();
  const sourceGroups: AiInputSourceGroup[] = [];
  function refForEntity(entityName: string): string {
    const existing = sourceGroupRefByName.get(entityName);
    if (existing) return existing;
    if (sourceGroups.length >= MAX_SOURCE_GROUPS_FOR_AI) return "";
    const ref = `SOURCE-GROUP-${sourceGroups.length + 1}`;
    sourceGroupRefByName.set(entityName, ref);
    sourceGroups.push({ ref, entityName: truncate(entityName, MAX_ITEM_TEXT_CHARS) });
    return ref;
  }

  const claimGroups: AiInputClaimGroup[] = coverage.claimGroups
    .slice(0, MAX_CLAIM_GROUPS_FOR_AI)
    .map((g, i) => ({
      ref: `CLAIM-GROUP-${i + 1}`,
      kind: g.kind,
      text: truncate(g.text, MAX_ITEM_TEXT_CHARS),
      articleCount: g.articleCount,
      publisherCount: g.publisherCount,
      numericUnit: g.numericUnit,
      numericValue: g.numericValue,
      numericQualifier: g.numericQualifier,
      sourceOverlapRefs: (g.sourceOverlap ?? [])
        .map((o) => refForEntity(o.entityName))
        .filter((ref): ref is string => ref !== ""),
    }));

  const headlineEntries = coverage.headlineComparison?.entries ?? [];
  const headlines: AiInputHeadline[] = headlineEntries
    .slice(0, MAX_HEADLINES_FOR_AI)
    .map((h, i) => ({
      ref: `HEADLINE-${i + 1}`,
      title: truncate(h.title, MAX_ITEM_TEXT_CHARS),
      publisherName: truncate(h.publisherName, MAX_ITEM_TEXT_CHARS),
      perspective: h.perspective,
    }));

  return {
    headline: truncate(params.headline, MAX_ITEM_TEXT_CHARS),
    articleCount: coverage.articleCount,
    publisherCount: coverage.publisherCount,
    notDetectedCount: intelligence?.sourcingNotDetectedCount ?? 0,
    originalReportingCount: intelligence?.originalReporting?.count ?? 0,
    claimGroups,
    sourceGroups,
    headlines,
    sharedHeadlineEntities: (coverage.headlineComparison?.sharedEntities ?? []).slice(0, 10),
    limitationsNote: coverage.limitationsNote,
  };
}

/** True when there is genuinely nothing for the model to synthesize — the caller must short-circuit before ever calling a provider (see storyBrief/generate.ts). */
export function isInputTooSparse(input: AiStoryBriefInput): boolean {
  const hasClaimGroups = input.claimGroups.length > 0;
  const hasHeadlineDifferences =
    input.headlines.length > 1 &&
    new Set(input.headlines.map((h) => h.title.trim().toLowerCase())).size > 1;
  return !hasClaimGroups && !hasHeadlineDifferences;
}
