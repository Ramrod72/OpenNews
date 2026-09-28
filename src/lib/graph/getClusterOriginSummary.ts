import type { PrismaClient } from "@prisma/client";
import {
  buildOriginalReportingSignals,
  buildPrimaryEvidenceGroups,
  buildSharedReportingSourceGroups,
  type ArticleForGrouping,
  type EntityForGrouping,
  type ObservationForGrouping,
} from "./buildSourceGroups";
import type { ClusterOriginSummary } from "./types";
import { EXTRACTOR_VERSION } from "@/lib/provenance/persistObservations";
import type {
  PersistableConfidence,
  ProvenanceEntityType,
  ProvenanceEvidenceType,
  ProvenanceRelationshipType,
} from "@/lib/validation/provenance";

/**
 * Phase 8B's internal service: the ONLY intended entry point into
 * src/lib/graph/ for the rest of the app (a future Phase 9). There is no
 * REST endpoint, no /api/provenance, no /api/graph, and no UI reading this
 * — it is a plain server-side async function, called directly.
 *
 * Everything it returns is derived at query time from Phase 7B's already-
 * persisted data plus the cluster's existing membership (see
 * src/lib/clustering/cluster.ts) — nothing is written, nothing is
 * persisted, nothing new is fetched over the network. Calling this
 * function has zero side effects.
 *
 * IMPORTANT — what StoryCluster membership does and doesn't mean: a
 * cluster groups articles the clustering engine judged topically similar
 * (TF-IDF cosine similarity over title/excerpt tokens — see cluster.ts).
 * That is a TOPIC signal, not a provenance signal. Being in the same
 * cluster is never, by itself, evidence that two articles share an origin,
 * and nothing below treats cluster membership that way — all reasoning
 * here is scoped to one cluster only because that's a natural, bounded,
 * useful unit of work, not because same-cluster implies same-origin.
 *
 * IMPORTANT — the Reuters/AP limitation: when many articles in a cluster
 * all cite the same wire service, this shows up as one
 * SHARED_REPORTING_SOURCE group naming that wire service. This means
 * "these articles cite the same reporting entity" — it does NOT mean the
 * same dispatch, the same report, the same origin, or that the underlying
 * facts are independently confirmed. Wire services are cited by many
 * unrelated outlets constantly; shared attribution to Reuters or AP is
 * completely ordinary and never, by itself, upgraded to a stronger claim
 * anywhere in this module.
 *
 * IMPORTANT — extractorVersion is never silently mixed: only the CURRENT
 * EXTRACTOR_VERSION's auto-generated observations (plus any ADMIN_OVERRIDE
 * row, regardless of its version tag) are loaded. An article that hasn't
 * been reprocessed since the last extractor version bump is treated the
 * same as an article with no provenance at all here — its stale rows are
 * excluded, not blended in with fresh ones from other articles in the same
 * cluster.
 *
 * IMPORTANT — entityType distinguishes two different kinds of "shared"
 * citation, and neither is a stronger claim than the other: a
 * WIRE_SERVICE/NEWS_OUTLET group means the articles cite a reporting
 * intermediary (Reuters, AP, another outlet). A GOVERNMENT_AGENCY/COURT/
 * LAW_ENFORCEMENT/COMPANY/RESEARCH_INSTITUTION/INDIVIDUAL group instead
 * means the articles cite the same PRIMARY SOURCE/newsmaker directly (e.g.
 * two articles both quoting the same DOJ statement) — routine, ordinary,
 * and, if anything, an even weaker signal than a wire-service citation,
 * since many outlets independently attending the same press conference or
 * receiving the same public statement is completely unremarkable. Callers
 * must inspect `entityType` rather than assuming every
 * SHARED_REPORTING_SOURCE group represents a reporting-intermediary
 * relationship.
 *
 * Bounded query shape: exactly three Prisma queries regardless of cluster
 * size — (1) a point lookup confirming the cluster exists, (2) one query
 * for the cluster's articles with their source name, excerpt, and
 * ProvenanceObservation rows via Prisma's relational include (a JOIN, not
 * an explicit article-id IN-list), and (3) one query for the full
 * ProvenanceEntity table (small by design — the same "load the whole small
 * table once" precedent Phase 7B's loadAliasIndex already established).
 * No query runs once per article or once per observation.
 */
export async function getClusterOriginSummary(
  prisma: PrismaClient,
  clusterId: string,
): Promise<ClusterOriginSummary> {
  const cluster = await prisma.storyCluster.findUnique({
    where: { id: clusterId },
    select: { id: true },
  });
  if (!cluster) {
    throw new Error(`getClusterOriginSummary: no StoryCluster with id ${clusterId}`);
  }

  const articleRows = await prisma.article.findMany({
    where: { clusterId },
    select: {
      id: true,
      sourceId: true,
      excerpt: true,
      source: { select: { id: true, name: true } },
      // Only the CURRENT extractor version's auto-generated rows, plus any
      // ADMIN_OVERRIDE row regardless of its version tag — the same
      // exclusion Phase 7B's own clearStaleObservations() applies before
      // reprocessing. Without this filter, an article not yet reprocessed
      // after an extractorVersion bump would keep contributing stale
      // (possibly since-corrected) observations indefinitely, silently
      // mixed in with fresh ones from other articles in the same cluster —
      // exactly the "misleading intelligence" this module must avoid. An
      // ADMIN_OVERRIDE row is never excluded by this filter: a human
      // correction must always be visible here, whatever extractorVersion
      // string it happens to carry.
      provenanceObservations: {
        where: {
          OR: [{ extractorVersion: EXTRACTOR_VERSION }, { reviewState: "ADMIN_OVERRIDE" }],
        },
        select: {
          id: true,
          articleId: true,
          entityId: true,
          rawEntityText: true,
          relationshipType: true,
          evidenceType: true,
          confidence: true,
          evidenceText: true,
        },
      },
    },
  });

  const entityRows = await prisma.provenanceEntity.findMany({
    select: { id: true, canonicalName: true, entityType: true, mergedIntoId: true },
  });

  const articles: ArticleForGrouping[] = articleRows.map((a) => ({
    id: a.id,
    sourceId: a.sourceId,
    sourceName: a.source.name,
    excerpt: a.excerpt,
  }));

  const observations: ObservationForGrouping[] = articleRows.flatMap((a) =>
    a.provenanceObservations.map((o) => ({
      id: o.id,
      articleId: o.articleId,
      entityId: o.entityId,
      rawEntityText: o.rawEntityText,
      relationshipType: o.relationshipType as ProvenanceRelationshipType,
      evidenceType: o.evidenceType as ProvenanceEvidenceType,
      // Persisted rows are always HIGH/MEDIUM (Phase 7B's locked precision
      // policy enforces this at the persistence boundary — a LOW value
      // here would itself be a Phase 7B bug, not something this module
      // needs to re-guard against).
      confidence: o.confidence as PersistableConfidence,
      evidenceText: o.evidenceText,
    })),
  );

  const entities: EntityForGrouping[] = entityRows.map((e) => ({
    id: e.id,
    canonicalName: e.canonicalName,
    entityType: e.entityType as ProvenanceEntityType,
    mergedIntoId: e.mergedIntoId,
  }));

  const publisherCount = new Set(articles.map((a) => a.sourceId)).size;

  const observationsByArticle = new Map<string, number>();
  for (const obs of observations) {
    observationsByArticle.set(obs.articleId, (observationsByArticle.get(obs.articleId) ?? 0) + 1);
  }
  const articlesWithoutDetectedProvenance = articles.filter(
    (a) => !observationsByArticle.get(a.id),
  ).length;
  const articlesWithDetectedProvenance = articles.length - articlesWithoutDetectedProvenance;

  const sharedReportingSourceGroups = buildSharedReportingSourceGroups({
    articles,
    observations,
    entities,
  });
  const primaryEvidenceGroups = buildPrimaryEvidenceGroups({ observations, entities });
  const originalReportingSignals = buildOriginalReportingSignals({ articles, observations });

  return {
    clusterId,
    articleCount: articles.length,
    publisherCount,
    sharedReportingSourceGroups,
    primaryEvidenceGroups,
    originalReportingSignals,
    unresolvedArticleCount: articlesWithoutDetectedProvenance,
    provenanceCoverage: {
      articlesWithDetectedProvenance,
      articlesWithoutDetectedProvenance,
    },
  };
}
