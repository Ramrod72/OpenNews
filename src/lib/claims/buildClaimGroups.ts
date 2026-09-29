import { buildTfIdfVectors, cosineSimilarity } from "@/lib/clustering/tfidf";
import { resolveCanonicalEntityId, type EntityForGrouping } from "@/lib/graph/buildSourceGroups";
import type { SharedReportingSourceGroup } from "@/lib/graph/types";
import type { ClaimKind, ClaimNumericQualifier, ClaimNumericUnit } from "@/lib/validation/claims";

/**
 * Pure, query-time, StoryCluster-scoped claim grouping — no Prisma, no
 * I/O, deterministic. Mirrors src/lib/graph/buildSourceGroups.ts exactly:
 * Claim rows are PERSISTED per-article facts (like ProvenanceObservation);
 * a ClaimGroup is NEVER persisted (like SharedReportingSourceGroup isn't)
 * — recomputed fresh from already-loaded claims on every request. See
 * ARCHITECTURE.md's Phase 10B section for the full rationale.
 *
 * LOCKED EPISTEMIC RULE this module exists to enforce structurally, not
 * just in prose: REPETITION IS NOT CORROBORATION. A group's `articleCount`
 * is a plain count of distinct articles containing a similar claim —
 * nothing here computes, exposes, or implies an "independence count" or
 * corroboration score. `sourceOverlap` cross-references the SAME group's
 * article set against Phase 8's already-computed SharedReportingSourceGroups
 * as a SEPARATE, parallel fact (see this function's own doc comment below)
 * — never subtracted from articleCount, never combined into one number.
 */

export const MAX_GROUP_SIZE_FOR_TEXT_COMPARISON = 25;
export const SIMILARITY_THRESHOLD = 0.6;
export const MIN_ARTICLES_FOR_GROUP = 2;

export interface ClaimForGrouping {
  id: string;
  articleId: string;
  kind: ClaimKind;
  rawText: string;
  normalizedText: string;
  entityId: string | null;
  numericValue: number | null;
  numericUnit: ClaimNumericUnit | null;
  numericQualifier: ClaimNumericQualifier | null;
  confidence: "HIGH" | "MEDIUM";
}

export interface ClaimGroupSourceOverlap {
  entityName: string;
  /** How many of THIS group's own articles also appear in that Phase 8 reporting-source group — never subtracted from articleCount, never turned into a percentage/score. */
  overlapArticleCount: number;
}

export interface ClaimGroup {
  kind: ClaimKind;
  /** The group's representative claim (highest confidence, then earliest articleId) — the ONLY text ever shown for this group. */
  representativeText: string;
  articleCount: number;
  publisherCount: number;
  /** Every member claim (one per article, deduplicated) — the view-model layer (coverageComparisonView.ts) uses this to build per-article occurrence evidence for entitled viewers; never exposed to a client as-is. */
  members: ClaimForGrouping[];
  articleIds: string[];
  sourceOverlap: ClaimGroupSourceOverlap[];
  numericUnit?: ClaimNumericUnit;
  numericValue?: number;
  numericQualifier?: ClaimNumericQualifier;
  entityId?: string | null;
}

function distinctArticleCount(claims: readonly ClaimForGrouping[]): number {
  return new Set(claims.map((c) => c.articleId)).size;
}

function publisherCountFor(
  articleIds: readonly string[],
  articlesById: ReadonlyMap<string, { sourceId: string }>,
): number {
  const sourceIds = new Set<string>();
  for (const id of articleIds) {
    const article = articlesById.get(id);
    if (article) sourceIds.add(article.sourceId);
  }
  return sourceIds.size;
}

/** Collapses multiple claim rows from the SAME article (e.g. the same number mentioned twice) down to one representative row per article, sorted by articleId — occurrence display is per-article, not per-raw-extraction. */
function oneClaimPerArticle(claims: readonly ClaimForGrouping[]): ClaimForGrouping[] {
  const byArticle = new Map<string, ClaimForGrouping>();
  for (const claim of claims) {
    const existing = byArticle.get(claim.articleId);
    if (!existing || claim.id.localeCompare(existing.id) < 0) {
      byArticle.set(claim.articleId, claim);
    }
  }
  return Array.from(byArticle.values()).sort((a, b) => a.articleId.localeCompare(b.articleId));
}

function pickRepresentative(claims: readonly ClaimForGrouping[]): ClaimForGrouping {
  const CONFIDENCE_PRIORITY: Record<string, number> = { HIGH: 0, MEDIUM: 1 };
  return [...claims].sort(
    (a, b) =>
      (CONFIDENCE_PRIORITY[a.confidence] ?? 1) - (CONFIDENCE_PRIORITY[b.confidence] ?? 1) ||
      a.articleId.localeCompare(b.articleId) ||
      a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * Cross-references a group's article set against Phase 8's already-
 * computed SharedReportingSourceGroups for the SAME cluster — a SEPARATE,
 * parallel, purely descriptive fact ("N of these M articles also cite
 * Reuters"), never combined into articleCount and never turned into an
 * independence/corroboration score. This is the direct operationalization
 * of the locked "repetition is not corroboration" rule: a consumer sees
 * "appears in 15 articles" AND, separately, "9 of these also cite
 * Reuters" — never a single derived number.
 */
function computeSourceOverlap(
  groupArticleIds: readonly string[],
  sharedReportingSourceGroups: readonly SharedReportingSourceGroup[],
): ClaimGroupSourceOverlap[] {
  const groupSet = new Set(groupArticleIds);
  const overlaps: ClaimGroupSourceOverlap[] = [];
  for (const sourceGroup of sharedReportingSourceGroups) {
    let overlapCount = 0;
    for (const articleId of sourceGroup.articleIds) {
      if (groupSet.has(articleId)) overlapCount += 1;
    }
    if (overlapCount > 0) {
      overlaps.push({
        entityName: sourceGroup.entityCanonicalName,
        overlapArticleCount: overlapCount,
      });
    }
  }
  overlaps.sort(
    (a, b) =>
      b.overlapArticleCount - a.overlapArticleCount || a.entityName.localeCompare(b.entityName),
  );
  return overlaps;
}

/**
 * NUMERICAL_ASSERTION grouping needs no text-similarity comparison at
 * all — exact structural agreement on (unit, numericValue, qualifier) IS
 * the grouping key. This is both SAFER than fuzzy text comparison (a
 * qualifier or unit mismatch can never be silently smoothed over) and
 * strictly linear (one Map pass, no pairwise comparison, no bucket-size
 * cap needed): see this module's own epistemic-safety doc comment.
 */
function groupNumericalAssertions(
  claims: readonly ClaimForGrouping[],
  articlesById: ReadonlyMap<string, { sourceId: string }>,
  sharedReportingSourceGroups: readonly SharedReportingSourceGroup[],
): ClaimGroup[] {
  const buckets = new Map<string, ClaimForGrouping[]>();
  for (const claim of claims) {
    const key = `${claim.numericUnit}::${claim.numericValue}::${claim.numericQualifier}`;
    const list = buckets.get(key) ?? [];
    list.push(claim);
    buckets.set(key, list);
  }

  const groups: ClaimGroup[] = [];
  for (const bucket of buckets.values()) {
    if (distinctArticleCount(bucket) < MIN_ARTICLES_FOR_GROUP) continue;
    const representative = pickRepresentative(bucket);
    const members = oneClaimPerArticle(bucket);
    const articleIds = members.map((c) => c.articleId).sort();
    groups.push({
      kind: "NUMERICAL_ASSERTION",
      representativeText: representative.rawText,
      articleCount: articleIds.length,
      publisherCount: publisherCountFor(articleIds, articlesById),
      members,
      articleIds,
      sourceOverlap: computeSourceOverlap(articleIds, sharedReportingSourceGroups),
      numericUnit: representative.numericUnit ?? undefined,
      numericValue: representative.numericValue ?? undefined,
      numericQualifier: representative.numericQualifier ?? undefined,
    });
  }
  return groups;
}

/**
 * ATTRIBUTED_STATEMENT grouping: first bucket by resolved canonical entity
 * (an entity-merge-aware exact match — reuses Phase 8's own
 * resolveCanonicalEntityId so a merged "DOJ"/"Department of Justice"
 * entity resolves identically here and in Phase 8's own grouping). Same
 * entity alone is NOT sufficient to group two statements (see this
 * module's doc comment) — within each entity bucket, a conservative
 * single-linkage text-similarity clustering (TF-IDF cosine over
 * normalizedText, same threshold excerptSimilarity.ts already uses for
 * near-duplicate detection) further splits the bucket into groups whose
 * members are actually similar statements, not just the same speaker.
 *
 * A bucket larger than MAX_GROUP_SIZE_FOR_TEXT_COMPARISON is skipped
 * entirely for THIS entity — never compared exhaustively (O(k^2) on an
 * unbounded k), and never grouped by entity alone either. Absence of a
 * group here must never be read as "these statements disagree" — only
 * that the cluster was too large to safely compare (see this module's own
 * cap-driven-degradation policy, matching MAX_GROUP_SIZE_FOR_TEXT_COMPARISON's
 * own precedent in excerptSimilarity.ts).
 */
function groupAttributedStatements(
  claims: readonly ClaimForGrouping[],
  entities: readonly EntityForGrouping[],
  articlesById: ReadonlyMap<string, { sourceId: string }>,
  sharedReportingSourceGroups: readonly SharedReportingSourceGroup[],
): ClaimGroup[] {
  const entitiesById = new Map(entities.map((e) => [e.id, e]));

  const buckets = new Map<string, ClaimForGrouping[]>();
  for (const claim of claims) {
    const canonicalId = claim.entityId
      ? resolveCanonicalEntityId(claim.entityId, entitiesById)
      : "";
    const list = buckets.get(canonicalId) ?? [];
    list.push(claim);
    buckets.set(canonicalId, list);
  }

  const groups: ClaimGroup[] = [];
  for (const [canonicalId, bucket] of buckets) {
    if (!canonicalId) continue; // unresolved entity — never grouped across articles (see doc comment)
    if (bucket.length > MAX_GROUP_SIZE_FOR_TEXT_COMPARISON) continue; // too large to safely compare — degrade to no grouping, not unsafe grouping

    // Sorted by id first so clustering never depends on the order claims
    // happened to arrive in from the database.
    const sortedBucket = [...bucket].sort((a, b) => a.id.localeCompare(b.id));
    const vectors = buildTfIdfVectors(
      sortedBucket.map((c) => ({ id: c.id, tokens: c.normalizedText.split(" ").filter(Boolean) })),
    );

    // Deterministic COMPLETE-linkage clustering: a claim joins an existing
    // cluster only when it clears SIMILARITY_THRESHOLD against EVERY
    // member already in that cluster — never merely one. A prior
    // single-linkage version (union two claims whenever ANY pair cleared
    // the threshold) allowed transitive chaining to silently merge two
    // claims with LOW mutual similarity into the same "common assertion"
    // group merely because both happened to be similar to some third,
    // intermediate claim (A~B and B~C would merge A and C into one group
    // even when sim(A,C) was well below threshold) — a real defect found
    // during the final adversarial review, since it violates the locked
    // "when uncertain, DO NOT GROUP" rule. Complete-linkage can never
    // produce a within-group pair below threshold, at the cost of
    // sometimes splitting into more (smaller, but internally coherent)
    // groups than a looser algorithm would — the correct direction to err
    // in, since a false split only under-counts a common assertion, while
    // a false merge would misrepresent two different statements as the
    // same one to a consumer.
    const clusters: ClaimForGrouping[][] = [];
    for (const claim of sortedBucket) {
      const vector = vectors.get(claim.id)!;
      const fittingCluster = clusters.find((cluster) =>
        cluster.every(
          (member) => cosineSimilarity(vector, vectors.get(member.id)!) >= SIMILARITY_THRESHOLD,
        ),
      );
      if (fittingCluster) {
        fittingCluster.push(claim);
      } else {
        clusters.push([claim]);
      }
    }

    for (const cluster of clusters) {
      if (distinctArticleCount(cluster) < MIN_ARTICLES_FOR_GROUP) continue;
      const representative = pickRepresentative(cluster);
      const members = oneClaimPerArticle(cluster);
      const articleIds = members.map((c) => c.articleId).sort();
      groups.push({
        kind: "ATTRIBUTED_STATEMENT",
        representativeText: representative.rawText,
        articleCount: articleIds.length,
        publisherCount: publisherCountFor(articleIds, articlesById),
        members,
        articleIds,
        sourceOverlap: computeSourceOverlap(articleIds, sharedReportingSourceGroups),
        entityId: representative.entityId,
      });
    }
  }
  return groups;
}

/**
 * Builds every claim group for one StoryCluster's already-loaded claims.
 * `claims` must already be scoped to one cluster (every claim's article
 * belongs to it) and to the CURRENT claimExtractorVersion — the caller
 * (coverageComparison.ts) is responsible for that filtering, exactly the
 * same division of responsibility getClusterOriginSummary.ts / caller
 * already establishes for Phase 8.
 */
export function buildClaimGroups(input: {
  claims: readonly ClaimForGrouping[];
  entities: readonly EntityForGrouping[];
  articlesById: ReadonlyMap<string, { sourceId: string }>;
  sharedReportingSourceGroups: readonly SharedReportingSourceGroup[];
}): ClaimGroup[] {
  const numerical = input.claims.filter((c) => c.kind === "NUMERICAL_ASSERTION");
  const attributed = input.claims.filter((c) => c.kind === "ATTRIBUTED_STATEMENT");

  const groups = [
    ...groupNumericalAssertions(numerical, input.articlesById, input.sharedReportingSourceGroups),
    ...groupAttributedStatements(
      attributed,
      input.entities,
      input.articlesById,
      input.sharedReportingSourceGroups,
    ),
  ];

  groups.sort(
    (a, b) =>
      b.articleCount - a.articleCount || a.representativeText.localeCompare(b.representativeText),
  );
  return groups;
}
