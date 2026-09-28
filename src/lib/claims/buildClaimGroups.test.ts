import { describe, expect, it } from "vitest";
import {
  buildClaimGroups,
  MAX_GROUP_SIZE_FOR_TEXT_COMPARISON,
  type ClaimForGrouping,
} from "./buildClaimGroups";
import type { EntityForGrouping } from "@/lib/graph/buildSourceGroups";
import type { SharedReportingSourceGroup } from "@/lib/graph/types";

function numClaim(
  overrides: Partial<ClaimForGrouping> & { id: string; articleId: string },
): ClaimForGrouping {
  return {
    kind: "NUMERICAL_ASSERTION",
    rawText: "12 people were injured.",
    normalizedText: "people were injured",
    entityId: null,
    numericValue: 12,
    numericUnit: "INJURIES",
    numericQualifier: "EXACT",
    confidence: "HIGH",
    ...overrides,
  };
}

function attrClaim(
  overrides: Partial<ClaimForGrouping> & { id: string; articleId: string },
): ClaimForGrouping {
  return {
    kind: "ATTRIBUTED_STATEMENT",
    rawText: "Reuters reported the negotiations concluded.",
    normalizedText: "reuters reported negotiations concluded",
    entityId: "ent-reuters",
    numericValue: null,
    numericUnit: null,
    numericQualifier: null,
    confidence: "HIGH",
    ...overrides,
  };
}

const noEntities: EntityForGrouping[] = [
  { id: "ent-reuters", canonicalName: "Reuters", entityType: "WIRE_SERVICE", mergedIntoId: null },
  {
    id: "ent-ap",
    canonicalName: "Associated Press",
    entityType: "WIRE_SERVICE",
    mergedIntoId: null,
  },
  { id: "ent-doj", canonicalName: "DOJ", entityType: "GOVERNMENT_AGENCY", mergedIntoId: null },
];

function articlesById(ids: string[]): Map<string, { sourceId: string }> {
  return new Map(ids.map((id) => [id, { sourceId: `src-${id}` }]));
}

const noSourceGroups: SharedReportingSourceGroup[] = [];

describe("A/B — identical numerical assertion groups across articles", () => {
  it("groups two articles with the exact same unit/value/qualifier", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a2" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "NUMERICAL_ASSERTION",
      articleCount: 2,
      publisherCount: 2,
    });
  });
});

describe("C — same number, different unit never groups", () => {
  it("does not group INJURIES and ARRESTS even with the same numeric value", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericUnit: "INJURIES" }),
      numClaim({ id: "c2", articleId: "a2", numericUnit: "ARRESTS" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0); // each unit only has 1 article -> no group
  });
});

describe("D — same number, different predicate (PEOPLE vs INJURIES) never groups", () => {
  it("keeps PEOPLE and INJURIES units in separate buckets", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericUnit: "PEOPLE", confidence: "MEDIUM" }),
      numClaim({ id: "c2", articleId: "a2", numericUnit: "PEOPLE", confidence: "MEDIUM" }),
      numClaim({ id: "c3", articleId: "a3", numericUnit: "INJURIES" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2", "a3"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1); // only PEOPLE (2 articles) forms a group
    expect(groups[0]!.numericUnit).toBe("PEOPLE");
  });
});

describe("E — exact vs. at-least qualifier never groups together", () => {
  it("keeps EXACT and AT_LEAST as separate buckets even with the same value/unit", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericQualifier: "EXACT" }),
      numClaim({ id: "c2", articleId: "a2", numericQualifier: "AT_LEAST" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0); // each qualifier bucket only has 1 article
  });

  it("groups two AT_LEAST claims together, separately from EXACT", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericQualifier: "AT_LEAST" }),
      numClaim({ id: "c2", articleId: "a2", numericQualifier: "AT_LEAST" }),
      numClaim({ id: "c3", articleId: "a3", numericQualifier: "EXACT" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2", "a3"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.numericQualifier).toBe("AT_LEAST");
  });
});

describe("F — exact vs. approximate never groups", () => {
  it("keeps EXACT and APPROXIMATE separate", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericQualifier: "EXACT" }),
      numClaim({ id: "c2", articleId: "a2", numericQualifier: "APPROXIMATE" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0);
  });
});

describe("H — materially different number never groups", () => {
  it("keeps 12 and 30 as separate buckets", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1", numericValue: 12 }),
      numClaim({ id: "c2", articleId: "a2", numericValue: 30 }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0);
  });
});

describe("I — same attributed entity + similar statement groups", () => {
  it("groups two Reuters-attributed claims with high textual similarity", () => {
    const claims = [
      attrClaim({
        id: "c1",
        articleId: "a1",
        normalizedText: "reuters reported negotiations concluded successfully overnight",
      }),
      attrClaim({
        id: "c2",
        articleId: "a2",
        normalizedText: "reuters reported negotiations concluded successfully this morning",
      }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("ATTRIBUTED_STATEMENT");
  });
});

describe("J — same entity, materially different statement never groups", () => {
  it("does not group two Reuters claims about unrelated topics", () => {
    const claims = [
      attrClaim({
        id: "c1",
        articleId: "a1",
        normalizedText: "reuters reported the merger deal closed today",
      }),
      attrClaim({
        id: "c2",
        articleId: "a2",
        normalizedText: "reuters reported wildfire spread across acres overnight",
      }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0);
  });
});

describe("K — different entity, similar wording never groups", () => {
  it("does not group Reuters and AP even with near-identical statement text", () => {
    const claims = [
      attrClaim({
        id: "c1",
        articleId: "a1",
        entityId: "ent-reuters",
        normalizedText: "reported negotiations concluded successfully overnight",
      }),
      attrClaim({
        id: "c2",
        articleId: "a2",
        entityId: "ent-ap",
        normalizedText: "reported negotiations concluded successfully overnight",
      }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0);
  });
});

describe("L — unresolved entity never groups across articles", () => {
  it("two unresolved (entityId null) attributed claims never group, even with identical text", () => {
    const claims = [
      attrClaim({ id: "c1", articleId: "a1", entityId: null }),
      attrClaim({ id: "c2", articleId: "a2", entityId: null }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(0);
  });
});

describe("M — duplicate claim rows in the same article do not inflate articleCount", () => {
  it("two claim rows from the same article count as one article in the group", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a1" }), // same article, different row
      numClaim({ id: "c3", articleId: "a2" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.articleCount).toBe(2);
    expect(groups[0]!.members).toHaveLength(2); // one member per article, not per row
  });
});

describe("O/P/Q — Phase 8 source-overlap cross-reference (repetition vs. corroboration)", () => {
  const reutersSourceGroup: SharedReportingSourceGroup = {
    groupType: "SHARED_REPORTING_SOURCE",
    entityId: "ent-reuters",
    entityCanonicalName: "Reuters",
    entityType: "WIRE_SERVICE",
    confidence: "POSSIBLE",
    articleIds: ["a1", "a2", "a3"],
    observations: [],
    nearDuplicateTextSignals: [],
  };
  const apSourceGroup: SharedReportingSourceGroup = {
    groupType: "SHARED_REPORTING_SOURCE",
    entityId: "ent-ap",
    entityCanonicalName: "Associated Press",
    entityType: "WIRE_SERVICE",
    confidence: "POSSIBLE",
    articleIds: ["a4", "a5"],
    observations: [],
    nearDuplicateTextSignals: [],
  };

  it("O: exposes overlapArticleCount for Reuters as a separate fact, never subtracted from articleCount", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a2" }),
      numClaim({ id: "c3", articleId: "a3" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2", "a3"]),
      sharedReportingSourceGroups: [reutersSourceGroup],
    });
    expect(groups[0]!.articleCount).toBe(3); // true count, untouched
    expect(groups[0]!.sourceOverlap).toEqual([{ entityName: "Reuters", overlapArticleCount: 3 }]);
  });

  it("P: AP overlap is reported separately from Reuters overlap when both are present", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a4" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a4"]),
      sharedReportingSourceGroups: [reutersSourceGroup, apSourceGroup],
    });
    const overlapEntities = groups[0]!.sourceOverlap.map((o) => o.entityName).sort();
    expect(overlapEntities).toEqual(["Associated Press", "Reuters"]);
  });

  it("Q: sourceOverlap is never combined into articleCount or any single derived number", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a2" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: [reutersSourceGroup],
    });
    // articleCount reflects the group's own true article count (2), NOT
    // reduced by however many of those also cite Reuters.
    expect(groups[0]!.articleCount).toBe(2);
    expect(Object.keys(groups[0]!)).not.toContain("independenceScore");
    expect(Object.keys(groups[0]!)).not.toContain("confirmationCount");
  });
});

describe("V — entity merge resolution (canonical entity, mirroring Phase 8)", () => {
  it("groups two claims resolved to entities that merge into the same canonical entity", () => {
    const mergedEntities: EntityForGrouping[] = [
      {
        id: "ent-doj-dup",
        canonicalName: "Department of Justice",
        entityType: "GOVERNMENT_AGENCY",
        mergedIntoId: "ent-doj",
      },
      { id: "ent-doj", canonicalName: "DOJ", entityType: "GOVERNMENT_AGENCY", mergedIntoId: null },
    ];
    const claims = [
      attrClaim({ id: "c1", articleId: "a1", entityId: "ent-doj-dup" }),
      attrClaim({ id: "c2", articleId: "a2", entityId: "ent-doj" }),
    ];
    const groups = buildClaimGroups({
      claims,
      entities: mergedEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.articleCount).toBe(2);
  });
});

describe("W/X — 1 article and 0 articles never form a group", () => {
  it("W: a single-article claim never forms a group", () => {
    const claims = [numClaim({ id: "c1", articleId: "a1" })];
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1"]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toEqual([]);
  });

  it("X: zero claims produces zero groups", () => {
    const groups = buildClaimGroups({
      claims: [],
      entities: noEntities,
      articlesById: articlesById([]),
      sharedReportingSourceGroups: noSourceGroups,
    });
    expect(groups).toEqual([]);
  });
});

describe("Y — 1,000-article numerical bucket stays a single group and completes fast", () => {
  it("groups 1,000 identical numerical claims without any pairwise comparison", () => {
    const claims: ClaimForGrouping[] = Array.from({ length: 1000 }, (_, i) =>
      numClaim({ id: `c${i}`, articleId: `a${i}` }),
    );
    const start = Date.now();
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(claims.map((c) => c.articleId)),
      sharedReportingSourceGroups: noSourceGroups,
    });
    const elapsed = Date.now() - start;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.articleCount).toBe(1000);
    expect(elapsed).toBeLessThan(2000); // structural bucketing, no O(n^2) comparison
  });
});

describe("Z — giant attributed-statement bucket degrades to no grouping, not unsafe grouping", () => {
  it("skips text-similarity grouping entirely for a same-entity bucket over MAX_GROUP_SIZE_FOR_TEXT_COMPARISON", () => {
    const n = MAX_GROUP_SIZE_FOR_TEXT_COMPARISON + 5;
    const claims: ClaimForGrouping[] = Array.from({ length: n }, (_, i) =>
      attrClaim({
        id: `c${i}`,
        articleId: `a${i}`,
        normalizedText: "reuters reported negotiations concluded successfully overnight",
      }),
    );
    const groups = buildClaimGroups({
      claims,
      entities: noEntities,
      articlesById: articlesById(claims.map((c) => c.articleId)),
      sharedReportingSourceGroups: noSourceGroups,
    });
    // Absence of a group here must not be read as "these statements
    // disagree" — only that the bucket was too large to safely compare.
    expect(groups).toEqual([]);
  });
});

describe("determinism", () => {
  it("identical input always produces identical output", () => {
    const claims = [
      numClaim({ id: "c1", articleId: "a1" }),
      numClaim({ id: "c2", articleId: "a2" }),
      attrClaim({ id: "c3", articleId: "a1" }),
      attrClaim({ id: "c4", articleId: "a2" }),
    ];
    const input = {
      claims,
      entities: noEntities,
      articlesById: articlesById(["a1", "a2"]),
      sharedReportingSourceGroups: noSourceGroups,
    };
    expect(buildClaimGroups(input)).toEqual(buildClaimGroups(input));
  });
});
