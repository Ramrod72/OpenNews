import { prisma } from "@/lib/db";
import { getClusterOriginSummary } from "@/lib/graph/getClusterOriginSummary";
import { can } from "@/lib/entitlements";
import { buildClaimGroups, type ClaimForGrouping } from "@/lib/claims/buildClaimGroups";
import { CLAIM_EXTRACTOR_VERSION } from "@/lib/claims/persistClaims";
import { compareHeadlines } from "@/lib/headlineComparison";
import {
  buildCoverageComparisonView,
  type CoverageComparisonResult,
  type ViewArticleForCoverage,
} from "@/lib/coverageComparisonView";
import type { EntityForGrouping } from "@/lib/graph/buildSourceGroups";
import type { ClaimKind, ClaimNumericQualifier, ClaimNumericUnit } from "@/lib/validation/claims";
import type { ProvenanceEntityType } from "@/lib/validation/provenance";
import type { StoryClusterCard } from "@/lib/stories";

/**
 * Phase 10B's server-only orchestrator, mirroring src/lib/storyIntelligence.ts
 * exactly: loads Phase 8's ClusterOriginSummary (reused as-is — this
 * module never reimplements shared-reporting-source-group logic), this
 * cluster's current-version Claim rows, and the viewer's entitlement, then
 * maps everything through the safe view-model layer. The ONLY place
 * Coverage Comparison data is loaded — src/components/story/CoverageComparison.tsx
 * calls this once and passes the result straight through.
 *
 * Failure isolation, matching Phase 9B's own corrected pattern exactly:
 * each entitlement check has its OWN try/catch and fails CLOSED
 * independently (an entitlement-service hiccup degrades that one flag to
 * false — never grants access, never hides already-available data);
 * getClusterOriginSummary / the claim and entity queries throwing means
 * there's nothing safe to show, so only that failure resolves the whole
 * section to `{ status: "unavailable" }`.
 */
export async function loadCoverageComparison(
  cluster: StoryClusterCard,
  userId: string | null,
): Promise<CoverageComparisonResult> {
  let hasFullAccess = false;
  try {
    hasFullAccess = await can(userId, "coverage_comparison_full");
  } catch (err) {
    console.error(
      `[coverageComparison] coverage_comparison_full lookup failed for cluster ${cluster.id}, defaulting to no full access:`,
      err,
    );
    hasFullAccess = false;
  }

  let hasClaimComparison = false;
  try {
    hasClaimComparison = await can(userId, "claim_comparison");
  } catch (err) {
    console.error(
      `[coverageComparison] claim_comparison lookup failed for cluster ${cluster.id}, defaulting to no claim comparison:`,
      err,
    );
    hasClaimComparison = false;
  }

  try {
    const articleIds = cluster.articles.map((a) => a.id);

    const [summary, claimRows, entityRows] = await Promise.all([
      getClusterOriginSummary(prisma, cluster.id),
      prisma.claim.findMany({
        where: {
          articleId: { in: articleIds },
          OR: [
            { claimExtractorVersion: CLAIM_EXTRACTOR_VERSION },
            { reviewState: "ADMIN_OVERRIDE" },
          ],
        },
        select: {
          id: true,
          articleId: true,
          kind: true,
          rawText: true,
          normalizedText: true,
          entityId: true,
          numericValue: true,
          numericUnit: true,
          numericQualifier: true,
          confidence: true,
        },
      }),
      prisma.provenanceEntity.findMany({
        select: { id: true, canonicalName: true, entityType: true, mergedIntoId: true },
      }),
    ]);

    const articles: ViewArticleForCoverage[] = cluster.articles.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      source: { id: a.source.id, name: a.source.name },
    }));
    const articlesById = new Map(articles.map((a) => [a.id, { sourceId: a.source.id }]));

    const claims: ClaimForGrouping[] = claimRows.map((c) => ({
      id: c.id,
      articleId: c.articleId,
      kind: c.kind as ClaimKind,
      rawText: c.rawText,
      normalizedText: c.normalizedText,
      entityId: c.entityId,
      numericValue: c.numericValue,
      numericUnit: c.numericUnit as ClaimNumericUnit | null,
      numericQualifier: c.numericQualifier as ClaimNumericQualifier | null,
      confidence: c.confidence as "HIGH" | "MEDIUM",
    }));

    const entities: EntityForGrouping[] = entityRows.map((e) => ({
      id: e.id,
      canonicalName: e.canonicalName,
      entityType: e.entityType as ProvenanceEntityType,
      mergedIntoId: e.mergedIntoId,
    }));

    const claimGroups = buildClaimGroups({
      claims,
      entities,
      articlesById,
      sharedReportingSourceGroups: summary.sharedReportingSourceGroups,
    });

    const headlineComparison = compareHeadlines(cluster.articles);

    return buildCoverageComparisonView({
      articleCount: summary.articleCount,
      publisherCount: summary.publisherCount,
      claimGroups,
      headlineComparison,
      articles,
      hasFullAccess,
      hasClaimComparison,
    });
  } catch (err) {
    console.error(`[coverageComparison] failed to load for cluster ${cluster.id}:`, err);
    return { status: "unavailable" };
  }
}
