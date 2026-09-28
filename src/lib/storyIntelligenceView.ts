import type { ClusterOriginSummary, ObservationRef } from "@/lib/graph/types";
import type { ProvenanceEntityType } from "@/lib/validation/provenance";
import { safeHttpUrl } from "@/lib/security/sanitize";

/**
 * Phase 9B — the ONE safe boundary between Phase 8's internal
 * ClusterOriginSummary (which carries observationId/entityId/confidence
 * enums/etc. — see graph/types.ts) and anything ever rendered to a
 * viewer. This module is a pure function of its inputs: no Prisma, no
 * auth, no I/O. `src/lib/storyIntelligence.ts` is responsible for loading
 * ClusterOriginSummary and the viewer's entitlement, then calling this.
 *
 * The returned StoryIntelligenceView (or Unavailable) is the ONLY shape
 * ever passed to a Client Component (EvidenceDrawer) — it never contains
 * observationId, entityId, extractorVersion, reviewState, dedupeKey,
 * startOffset/endOffset, or any other Phase 7/8 internal identifier.
 * `articleId` is not internal (it identifies a public Article the page
 * already shows) and is kept only as a stable list key.
 *
 * hasFullAccess controls what's INCLUDED in the object, not what's
 * hidden by CSS: a viewer without provenance_full simply never has
 * `articles`/`evidence` populated on a group, and never gets more than
 * MAX_FREE_REPORTING_GROUPS groups at all — there is no premium data in
 * the object for a CSS layer to hide.
 */

export const MAX_FREE_REPORTING_GROUPS = 2;
export const MAX_EVIDENCE_PER_ARTICLE = 5;
/**
 * Defensive cap on how many articles/evidence rows a single group renders.
 * Phase 8 itself is tested against 1,000-article clusters (all citing one
 * entity) — without this, a single expanded group could try to render
 * 1,000 article rows and up to 5,000 evidence snippets. Articles beyond
 * this bound are simply omitted from `articles`/`evidence`; `articleCount`
 * itself always reflects the true, untruncated total.
 */
export const MAX_ARTICLES_PER_GROUP_DISPLAY = 50;

/**
 * Hard ceiling on the TOTAL number of evidence snippets one group ever
 * renders, independent of MAX_ARTICLES_PER_GROUP_DISPLAY /
 * MAX_EVIDENCE_PER_ARTICLE. Those two caps bound article rows and
 * per-article snippets separately, but their product is still large: 50
 * articles x 5 snippets x a 200-char evidence-text cap
 * (MAX_EVIDENCE_TEXT_LENGTH in persistObservations.ts) is up to ~50,000
 * characters of publisher-sourced text for one expanded group — well past
 * what "supporting evidence for a citation" should ever mean. This caps the
 * flattened, already-priority-ordered evidence list (HIGH before MEDIUM,
 * displayed-article order otherwise) rather than changing what's selected
 * per article.
 */
export const MAX_EVIDENCE_ITEMS_PER_GROUP = 100;

/** Entity types that represent a reporting intermediary (a wire service or another outlet), vs. a directly-cited primary source. */
const REPORTING_INTERMEDIARY_ENTITY_TYPES: ReadonlySet<ProvenanceEntityType> = new Set([
  "WIRE_SERVICE",
  "NEWS_OUTLET",
]);

export type ReportingSourceKind = "reporting_intermediary" | "referenced_source";

export interface ViewArticle {
  id: string;
  title: string;
  url: string;
  source: { id: string; name: string };
}

export interface StoryIntelligenceArticleLink {
  articleId: string;
  title: string;
  url: string;
  publisherName: string;
  publisherSourceId: string;
}

export interface StoryIntelligenceEvidenceItem {
  articleId: string;
  title: string;
  url: string;
  publisherName: string;
  publisherSourceId: string;
  evidenceText: string;
}

export interface ReportingSourceGroupView {
  /** Stable, already-public identifier for React list keys — never the internal entity cuid. */
  key: string;
  entityName: string;
  kind: ReportingSourceKind;
  articleCount: number;
  /** Present only when hasFullAccess is true. */
  articles?: StoryIntelligenceArticleLink[];
  /** Present only when hasFullAccess is true; capped at MAX_EVIDENCE_PER_ARTICLE per article. */
  evidence?: StoryIntelligenceEvidenceItem[];
}

export interface OriginalReportingView {
  count: number;
  /** Present only when hasFullAccess is true. */
  items?: StoryIntelligenceEvidenceItem[];
}

export interface StoryIntelligenceView {
  status: "ok";
  articleCount: number;
  publisherCount: number;
  hasFullAccess: boolean;
  reportingSourceGroups: ReportingSourceGroupView[];
  /** True count of groups Phase 8 found, even when the array above was truncated for a Free/logged-out viewer. */
  totalReportingSourceGroupCount: number;
  originalReporting: OriginalReportingView | null;
  sourcingNotDetectedCount: number;
}

export interface StoryIntelligenceUnavailable {
  status: "unavailable";
}

export type StoryIntelligenceResult = StoryIntelligenceView | StoryIntelligenceUnavailable;

function reportingSourceKind(entityType: ProvenanceEntityType): ReportingSourceKind {
  return REPORTING_INTERMEDIARY_ENTITY_TYPES.has(entityType)
    ? "reporting_intermediary"
    : "referenced_source";
}

/**
 * Article.url is untrusted: it ultimately comes from a publisher's RSS
 * feed, and normalizeUrl() (src/lib/ingest/normalize.ts) only canonicalizes
 * a URL — it does not restrict its scheme. A malicious or compromised feed
 * could in principle supply a `javascript:`/`data:`/`vbscript:` link, which
 * would otherwise render as a clickable <a href> in EvidenceDrawer.tsx.
 * safeHttpUrl (src/lib/security/sanitize.ts, the same convention
 * safeImageUrl already establishes for feed-supplied image URLs) strips
 * this down to only plain http(s) URLs; "" signals no safe link is
 * available, and EvidenceDrawer renders that case as plain (non-clickable)
 * text rather than an anchor.
 */
function safeArticleHref(url: string): string {
  return safeHttpUrl(url) ?? "";
}

function toArticleLink(
  articleId: string,
  articlesById: ReadonlyMap<string, ViewArticle>,
): StoryIntelligenceArticleLink | null {
  const article = articlesById.get(articleId);
  if (!article) return null;
  return {
    articleId: article.id,
    title: article.title,
    url: safeArticleHref(article.url),
    publisherName: article.source.name,
    publisherSourceId: article.source.id,
  };
}

const CONFIDENCE_PRIORITY: Record<string, number> = { HIGH: 0, MEDIUM: 1 };

/**
 * Per article, at most MAX_EVIDENCE_PER_ARTICLE snippets — HIGH
 * prioritized over MEDIUM (stable sort, so relative order among
 * same-confidence observations is preserved), confidence itself dropped
 * from the output entirely (never exposed as a consumer-facing label).
 * Deterministic: `observations` always arrives already sorted by
 * observationId (see buildSourceGroups.ts), and grouping by articleId via
 * a Map preserves that input order.
 */
function selectEvidence(
  observations: readonly ObservationRef[],
  articlesById: ReadonlyMap<string, ViewArticle>,
): StoryIntelligenceEvidenceItem[] {
  const byArticle = new Map<string, ObservationRef[]>();
  for (const obs of observations) {
    const list = byArticle.get(obs.articleId) ?? [];
    list.push(obs);
    byArticle.set(obs.articleId, list);
  }

  const items: StoryIntelligenceEvidenceItem[] = [];
  for (const [articleId, obsList] of byArticle) {
    const article = articlesById.get(articleId);
    if (!article) continue;
    const prioritized = [...obsList].sort(
      (a, b) => (CONFIDENCE_PRIORITY[a.confidence] ?? 1) - (CONFIDENCE_PRIORITY[b.confidence] ?? 1),
    );
    for (const obs of prioritized.slice(0, MAX_EVIDENCE_PER_ARTICLE)) {
      items.push({
        articleId: article.id,
        title: article.title,
        url: safeArticleHref(article.url),
        publisherName: article.source.name,
        publisherSourceId: article.source.id,
        evidenceText: obs.evidenceText,
      });
    }
  }
  return items;
}

/**
 * Pure mapping from Phase 8's ClusterOriginSummary (plus the story page's
 * already-loaded article/source rows) to the one safe shape any UI may
 * render. Deterministic: sorts reporting-source groups by article count
 * descending (most-cited first — a presentation choice; Phase 8's own
 * internal order is alphabetical and isn't meaningful for display), tying
 * on entity name for stability.
 */
export function buildStoryIntelligenceView(
  summary: ClusterOriginSummary,
  articles: readonly ViewArticle[],
  hasFullAccess: boolean,
): StoryIntelligenceView {
  const articlesById = new Map(articles.map((a) => [a.id, a]));

  const allGroups: ReportingSourceGroupView[] = summary.sharedReportingSourceGroups.map((g) => {
    const base: ReportingSourceGroupView = {
      key: g.entityCanonicalName,
      entityName: g.entityCanonicalName,
      kind: reportingSourceKind(g.entityType),
      articleCount: g.articleIds.length,
    };
    if (!hasFullAccess) return base;

    // Deterministic (articleIds already sorted) bound on how many
    // articles/evidence rows this group ever renders, independent of
    // `articleCount` itself (see MAX_ARTICLES_PER_GROUP_DISPLAY).
    const displayedArticleIds = g.articleIds.slice(0, MAX_ARTICLES_PER_GROUP_DISPLAY);
    const displayedArticleIdSet = new Set(displayedArticleIds);
    const displayedObservations = g.observations.filter((o) =>
      displayedArticleIdSet.has(o.articleId),
    );

    return {
      ...base,
      articles: displayedArticleIds
        .map((id) => toArticleLink(id, articlesById))
        .filter((a): a is StoryIntelligenceArticleLink => a !== null),
      evidence: selectEvidence(displayedObservations, articlesById).slice(
        0,
        MAX_EVIDENCE_ITEMS_PER_GROUP,
      ),
    };
  });

  allGroups.sort(
    (a, b) => b.articleCount - a.articleCount || a.entityName.localeCompare(b.entityName),
  );

  const totalReportingSourceGroupCount = allGroups.length;
  const reportingSourceGroups = hasFullAccess
    ? allGroups
    : allGroups.slice(0, MAX_FREE_REPORTING_GROUPS);

  const originalReporting: OriginalReportingView | null =
    summary.originalReportingSignals.length === 0
      ? null
      : {
          count: summary.originalReportingSignals.length,
          items: hasFullAccess
            ? summary.originalReportingSignals
                .slice(0, MAX_ARTICLES_PER_GROUP_DISPLAY)
                .map((s): StoryIntelligenceEvidenceItem | null => {
                  const article = articlesById.get(s.articleId);
                  if (!article) return null;
                  return {
                    articleId: article.id,
                    title: article.title,
                    url: safeArticleHref(article.url),
                    publisherName: article.source.name,
                    publisherSourceId: article.source.id,
                    evidenceText: s.evidenceText,
                  };
                })
                .filter((x): x is StoryIntelligenceEvidenceItem => x !== null)
            : undefined,
        };

  return {
    status: "ok",
    articleCount: summary.articleCount,
    publisherCount: summary.publisherCount,
    hasFullAccess,
    reportingSourceGroups,
    totalReportingSourceGroupCount,
    originalReporting,
    sourcingNotDetectedCount: summary.unresolvedArticleCount,
  };
}
