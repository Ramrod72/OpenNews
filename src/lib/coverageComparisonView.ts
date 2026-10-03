import type { ClaimGroup } from "@/lib/claims/buildClaimGroups";
import type { HeadlineComparisonView } from "@/lib/headlineComparison";
import { safeHttpUrl } from "@/lib/security/sanitize";
import type { ClaimNumericQualifier, ClaimNumericUnit } from "@/lib/validation/claims";
import type { Perspective } from "@/lib/perspective";

/**
 * Phase 10B — the ONE safe boundary between the internal claim-grouping
 * shapes (ClaimGroup, whose `members` carry Claim's internal id/entityId/
 * offsets/confidence) and anything ever rendered to a viewer. Mirrors
 * src/lib/storyIntelligenceView.ts exactly: a pure function (no Prisma, no
 * auth, no I/O), narrow output types, and hasFullAccess/hasClaimComparison
 * controlling what's INCLUDED in the object — never what's hidden by CSS.
 *
 * Never exposed here, regardless of entitlement: Claim.id, entityId,
 * startOffset/endOffset, claimExtractorVersion, reviewState, dedupeKey,
 * raw confidence value, or any ProvenanceObservation-shaped field.
 */

export const MAX_FREE_CLAIM_GROUPS = 2;
export const MAX_CLAIM_GROUPS_DISPLAYED = 50;
export const MAX_OCCURRENCES_PER_GROUP_DISPLAY = 50;
export const MAX_HEADLINE_ENTRIES_FREE = 3;

export interface ViewArticleForCoverage {
  id: string;
  title: string;
  url: string;
  source: { id: string; name: string };
}

export interface ClaimOccurrenceView {
  articleId: string;
  title: string;
  url: string;
  publisherName: string;
  publisherSourceId: string;
  /** This article's own claim text — may differ slightly from the group's representative text. */
  text: string;
}

export interface SourceOverlapView {
  entityName: string;
  overlapArticleCount: number;
}

export interface ClaimGroupView {
  key: string;
  kind: "NUMERICAL_ASSERTION" | "ATTRIBUTED_STATEMENT";
  text: string;
  articleCount: number;
  publisherCount: number;
  numericUnit?: ClaimNumericUnit;
  numericValue?: number;
  numericQualifier?: ClaimNumericQualifier;
  /** Present for hasFullAccess (Basic+) viewers only. */
  sourceOverlap?: SourceOverlapView[];
  /** Present for hasClaimComparison (Pro) viewers only. */
  occurrences?: ClaimOccurrenceView[];
}

export interface HeadlineEntryView {
  articleId: string;
  title: string;
  url: string;
  publisherName: string;
  publisherSourceId: string;
  entities: string[];
  perspective: Perspective;
}

export interface HeadlineComparisonSectionView {
  entries: HeadlineEntryView[];
  sharedEntities: string[];
  /** True when entries[] was truncated for a non-entitled viewer — true count is entries seen elsewhere; kept simple since headline entries are always small in number (one per article). */
  truncated: boolean;
}

export interface CoverageComparisonView {
  status: "ok";
  hasFullAccess: boolean;
  hasClaimComparison: boolean;
  articleCount: number;
  publisherCount: number;
  claimGroups: ClaimGroupView[];
  totalClaimGroupCount: number;
  headlineComparison: HeadlineComparisonSectionView | null;
  limitationsNote: string;
}

export interface CoverageComparisonUnavailable {
  status: "unavailable";
}

export type CoverageComparisonResult = CoverageComparisonView | CoverageComparisonUnavailable;

const LIMITATIONS_NOTE =
  "Comparisons are based on the article text available to Veriqen News. Older or limited feeds may provide less text for comparison.";

function safeArticleHref(url: string): string {
  return safeHttpUrl(url) ?? "";
}

function toOccurrence(
  claimText: string,
  articleId: string,
  articlesById: ReadonlyMap<string, ViewArticleForCoverage>,
): ClaimOccurrenceView | null {
  const article = articlesById.get(articleId);
  if (!article) return null;
  return {
    articleId: article.id,
    title: article.title,
    url: safeArticleHref(article.url),
    publisherName: article.source.name,
    publisherSourceId: article.source.id,
    text: claimText,
  };
}

function buildClaimGroupView(
  group: ClaimGroup,
  index: number,
  articlesById: ReadonlyMap<string, ViewArticleForCoverage>,
  hasFullAccess: boolean,
  hasClaimComparison: boolean,
): ClaimGroupView {
  // Deliberately built ONLY from already-consumer-safe fields (kind,
  // position, numeric fields, first article id — article ids are already
  // exposed elsewhere in this same view, e.g. ClaimOccurrenceView.articleId
  // and HeadlineEntryView.articleId, to support internal routing). Must
  // NEVER incorporate group.entityId: a raw ProvenanceEntity id has no
  // legitimate consumer-facing use anywhere in the app and must not leak
  // into a Client Component's serialized props merely to make a React key
  // unique (regression-tested in coverageComparisonSafety.test.ts).
  const base: ClaimGroupView = {
    key: `${group.kind}-${index}-${group.numericUnit ?? ""}-${group.numericValue ?? ""}-${group.numericQualifier ?? ""}-${group.articleIds[0] ?? ""}`,
    kind: group.kind,
    text: group.representativeText,
    articleCount: group.articleCount,
    publisherCount: group.publisherCount,
    numericUnit: group.numericUnit,
    numericValue: group.numericValue,
    numericQualifier: group.numericQualifier,
  };

  if (!hasFullAccess) return base;

  const withOverlap: ClaimGroupView = { ...base, sourceOverlap: group.sourceOverlap };
  if (!hasClaimComparison) return withOverlap;

  const occurrences = group.members
    .slice(0, MAX_OCCURRENCES_PER_GROUP_DISPLAY)
    .map((m) => toOccurrence(m.rawText, m.articleId, articlesById))
    .filter((o): o is ClaimOccurrenceView => o !== null);

  return { ...withOverlap, occurrences };
}

function buildHeadlineSection(
  headline: HeadlineComparisonView,
  articlesById: ReadonlyMap<string, ViewArticleForCoverage>,
  hasFullAccess: boolean,
): HeadlineComparisonSectionView | null {
  if (headline.entries.length === 0) return null;

  const maxEntries = hasFullAccess ? headline.entries.length : MAX_HEADLINE_ENTRIES_FREE;
  const truncated = headline.entries.length > maxEntries;

  const entries: HeadlineEntryView[] = headline.entries.slice(0, maxEntries).map((e) => {
    const article = articlesById.get(e.articleId);
    return {
      articleId: e.articleId,
      title: e.title,
      url: article ? safeArticleHref(article.url) : "",
      publisherName: e.publisherName,
      publisherSourceId: e.publisherSourceId,
      entities: e.entities,
      perspective: e.perspective,
    };
  });

  return {
    entries,
    sharedEntities: hasFullAccess ? headline.sharedEntities : [],
    truncated,
  };
}

/**
 * Pure mapping from internal claim-grouping/headline-comparison shapes to
 * the one safe shape any UI may render. hasFullAccess corresponds to the
 * existing `coverage_comparison_full` entitlement (Basic+); hasClaimComparison
 * to the existing `claim_comparison` entitlement (Pro only) — no new
 * entitlement keys. Deterministic: sorts groups by article count
 * descending (most-repeated first), tying on representative text.
 */
export function buildCoverageComparisonView(input: {
  articleCount: number;
  publisherCount: number;
  claimGroups: readonly ClaimGroup[];
  headlineComparison: HeadlineComparisonView;
  articles: readonly ViewArticleForCoverage[];
  hasFullAccess: boolean;
  hasClaimComparison: boolean;
}): CoverageComparisonView {
  const articlesById = new Map(input.articles.map((a) => [a.id, a]));

  const sortedGroups = [...input.claimGroups].sort(
    (a, b) =>
      b.articleCount - a.articleCount || a.representativeText.localeCompare(b.representativeText),
  );

  const totalClaimGroupCount = sortedGroups.length;
  const visibleGroups = input.hasFullAccess
    ? sortedGroups.slice(0, MAX_CLAIM_GROUPS_DISPLAYED)
    : sortedGroups.slice(0, MAX_FREE_CLAIM_GROUPS);

  const claimGroups = visibleGroups.map((g, index) =>
    buildClaimGroupView(g, index, articlesById, input.hasFullAccess, input.hasClaimComparison),
  );

  return {
    status: "ok",
    hasFullAccess: input.hasFullAccess,
    hasClaimComparison: input.hasClaimComparison,
    articleCount: input.articleCount,
    publisherCount: input.publisherCount,
    claimGroups,
    totalClaimGroupCount,
    headlineComparison: buildHeadlineSection(
      input.headlineComparison,
      articlesById,
      input.hasFullAccess,
    ),
    limitationsNote: LIMITATIONS_NOTE,
  };
}
