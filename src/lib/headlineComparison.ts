import { extractKeywordPhrases } from "@/lib/nlp/keywords";
import { findNumberCandidates, suppressOverlappingCandidates } from "@/lib/claims/numberPatterns";
import { classifyPerspective, type Perspective } from "@/lib/perspective";
import type { ClaimNumericUnit } from "@/lib/validation/claims";

/**
 * Purely descriptive headline comparison — headlines are the one text
 * surface that is COMPLETE (never truncated) for every article regardless
 * of age, making this the most reliable comparison signal Phase 10B has.
 * Deliberately stays descriptive rather than interpretive: this module
 * lists what each headline mentions (entities, numbers, publisher-labeled
 * perspective) and which entities are shared vs. not — it never scores
 * "framing," never infers motive, and never claims an entity's absence
 * from one headline means anything beyond "not mentioned in this
 * headline" (see coverageComparisonView.ts's terminology for the exact
 * consumer wording this maps to).
 */

export interface HeadlineNumber {
  unit: ClaimNumericUnit;
  numericValue: number;
}

export interface HeadlineEntry {
  articleId: string;
  publisherSourceId: string;
  publisherName: string;
  title: string;
  perspective: Perspective;
  entities: string[];
  numbers: HeadlineNumber[];
}

export interface HeadlineComparisonView {
  entries: HeadlineEntry[];
  /** Entities mentioned in 2+ headlines — a purely descriptive overlap list, never a "consensus" claim. */
  sharedEntities: string[];
}

const MAX_ENTITIES_PER_HEADLINE = 8; // extractKeywordPhrases already caps at 8 internally; kept explicit here for clarity

export function compareHeadlines(
  articles: readonly {
    id: string;
    title: string;
    url: string;
    source: { id: string; name: string };
  }[],
): HeadlineComparisonView {
  const entries: HeadlineEntry[] = articles.map((a) => {
    const numbers = suppressOverlappingCandidates(findNumberCandidates(a.title)).map((c) => ({
      unit: c.unit,
      numericValue: c.numericValue,
    }));
    return {
      articleId: a.id,
      publisherSourceId: a.source.id,
      publisherName: a.source.name,
      title: a.title,
      perspective: classifyPerspective(a),
      entities: extractKeywordPhrases(a.title).slice(0, MAX_ENTITIES_PER_HEADLINE),
      numbers,
    };
  });

  const entityArticleCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const entity of new Set(entry.entities)) {
      entityArticleCounts.set(entity, (entityArticleCounts.get(entity) ?? 0) + 1);
    }
  }
  const sharedEntities = Array.from(entityArticleCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([entity]) => entity)
    .sort();

  return { entries, sharedEntities };
}
