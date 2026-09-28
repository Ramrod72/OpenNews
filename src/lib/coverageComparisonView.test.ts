import { describe, expect, it } from "vitest";
import {
  buildCoverageComparisonView,
  MAX_FREE_CLAIM_GROUPS,
  type ViewArticleForCoverage,
} from "./coverageComparisonView";
import type { ClaimGroup, ClaimForGrouping } from "@/lib/claims/buildClaimGroups";
import type { HeadlineComparisonView } from "@/lib/headlineComparison";

const FORBIDDEN_KEYS = [
  "entityId",
  "claimExtractorVersion",
  "reviewState",
  "dedupeKey",
  "startOffset",
  "endOffset",
  "ADMIN_OVERRIDE",
  "normalizedText",
];

function article(
  id: string,
  overrides: Partial<ViewArticleForCoverage> = {},
): ViewArticleForCoverage {
  return {
    id,
    title: `Article ${id}`,
    url: `https://example.com/${id}`,
    source: { id: `src-${id}`, name: `Source ${id}` },
    ...overrides,
  };
}

function member(
  id: string,
  articleId: string,
  overrides: Partial<ClaimForGrouping> = {},
): ClaimForGrouping {
  return {
    id,
    articleId,
    kind: "NUMERICAL_ASSERTION",
    rawText: `Claim text for ${articleId}`,
    normalizedText: "claim text",
    entityId: null,
    numericValue: 12,
    numericUnit: "INJURIES",
    numericQualifier: "EXACT",
    confidence: "HIGH",
    ...overrides,
  };
}

function group(overrides: Partial<ClaimGroup> = {}): ClaimGroup {
  return {
    kind: "NUMERICAL_ASSERTION",
    representativeText: "12 people were injured",
    articleCount: 2,
    publisherCount: 2,
    members: [member("c1", "a1"), member("c2", "a2")],
    articleIds: ["a1", "a2"],
    sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
    numericUnit: "INJURIES",
    numericValue: 12,
    numericQualifier: "EXACT",
    ...overrides,
  };
}

const emptyHeadline: HeadlineComparisonView = { entries: [], sharedEntities: [] };

describe("Free/logged-out payload contains no premium evidence", () => {
  it("has no sourceOverlap/occurrences fields when hasFullAccess is false", () => {
    const view = buildCoverageComparisonView({
      articleCount: 2,
      publisherCount: 2,
      claimGroups: [group()],
      headlineComparison: emptyHeadline,
      articles: [article("a1"), article("a2")],
      hasFullAccess: false,
      hasClaimComparison: false,
    });
    expect(view.claimGroups[0]!.sourceOverlap).toBeUndefined();
    expect(view.claimGroups[0]!.occurrences).toBeUndefined();
  });

  it("truncates claim groups to MAX_FREE_CLAIM_GROUPS while exposing the true total", () => {
    const groups = Array.from({ length: 5 }, (_, i) =>
      group({ representativeText: `claim ${i}`, articleIds: [`a${i}`, `b${i}`] }),
    );
    const view = buildCoverageComparisonView({
      articleCount: 10,
      publisherCount: 10,
      claimGroups: groups,
      headlineComparison: emptyHeadline,
      articles: [],
      hasFullAccess: false,
      hasClaimComparison: false,
    });
    expect(view.claimGroups).toHaveLength(MAX_FREE_CLAIM_GROUPS);
    expect(view.totalClaimGroupCount).toBe(5);
  });
});

describe("Basic (hasFullAccess) gets sourceOverlap but not occurrences", () => {
  it("exposes sourceOverlap when hasFullAccess is true and hasClaimComparison is false", () => {
    const view = buildCoverageComparisonView({
      articleCount: 2,
      publisherCount: 2,
      claimGroups: [group()],
      headlineComparison: emptyHeadline,
      articles: [article("a1"), article("a2")],
      hasFullAccess: true,
      hasClaimComparison: false,
    });
    expect(view.claimGroups[0]!.sourceOverlap).toEqual([
      { entityName: "Reuters", overlapArticleCount: 2 },
    ]);
    expect(view.claimGroups[0]!.occurrences).toBeUndefined();
  });
});

describe("Pro (hasClaimComparison) gets occurrences", () => {
  it("exposes bounded occurrence article links when hasClaimComparison is true", () => {
    const view = buildCoverageComparisonView({
      articleCount: 2,
      publisherCount: 2,
      claimGroups: [group()],
      headlineComparison: emptyHeadline,
      articles: [article("a1"), article("a2")],
      hasFullAccess: true,
      hasClaimComparison: true,
    });
    expect(view.claimGroups[0]!.occurrences).toHaveLength(2);
    expect(view.claimGroups[0]!.occurrences![0]).toMatchObject({
      articleId: "a1",
      publisherSourceId: "src-a1",
    });
  });
});

describe("forbidden internal keys never appear in the serialized view", () => {
  it("no forbidden key appears anywhere in JSON.stringify(view), at any entitlement tier", () => {
    for (const [hasFullAccess, hasClaimComparison] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const view = buildCoverageComparisonView({
        articleCount: 2,
        publisherCount: 2,
        claimGroups: [group()],
        headlineComparison: emptyHeadline,
        articles: [article("a1"), article("a2")],
        hasFullAccess,
        hasClaimComparison,
      });
      const json = JSON.stringify(view);
      for (const key of FORBIDDEN_KEYS) {
        expect(json).not.toContain(key);
      }
    }
  });
});

describe("hostile article URL is sanitized in occurrences", () => {
  it("strips a javascript: article URL to an empty string", () => {
    const hostileArticle = article("a1", { url: "javascript:alert(1)" });
    const view = buildCoverageComparisonView({
      articleCount: 2,
      publisherCount: 2,
      claimGroups: [group()],
      headlineComparison: emptyHeadline,
      articles: [hostileArticle, article("a2")],
      hasFullAccess: true,
      hasClaimComparison: true,
    });
    const occ = view.claimGroups[0]!.occurrences!.find((o) => o.articleId === "a1")!;
    expect(occ.url).toBe("");
    expect(JSON.stringify(view)).not.toMatch(/javascript:/i);
  });
});

describe("headline comparison free-tier truncation", () => {
  it("caps headline entries for a non-entitled viewer", () => {
    const headline: HeadlineComparisonView = {
      entries: Array.from({ length: 6 }, (_, i) => ({
        articleId: `a${i}`,
        publisherSourceId: `src-a${i}`,
        publisherName: `Source ${i}`,
        title: `Title ${i}`,
        perspective: "reporting" as const,
        entities: [],
        numbers: [],
      })),
      sharedEntities: ["Geneva"],
    };
    const view = buildCoverageComparisonView({
      articleCount: 6,
      publisherCount: 6,
      claimGroups: [],
      headlineComparison: headline,
      articles: headline.entries.map((e) => article(e.articleId)),
      hasFullAccess: false,
      hasClaimComparison: false,
    });
    expect(view.headlineComparison!.entries.length).toBeLessThan(6);
    expect(view.headlineComparison!.truncated).toBe(true);
    expect(view.headlineComparison!.sharedEntities).toEqual([]); // hidden for non-entitled viewers
  });
});

describe("ATTRIBUTED_STATEMENT group's internal entityId value never leaks into the client-visible key", () => {
  it("view.claimGroups[0].key never contains the raw ProvenanceEntity id, even though it's used to build the group server-side", () => {
    const secretEntityId = "cm0secretentityid1234567890";
    const attributedGroup = group({
      kind: "ATTRIBUTED_STATEMENT",
      representativeText: "Officials said the fire was contained",
      numericUnit: undefined,
      numericValue: undefined,
      numericQualifier: undefined,
      entityId: secretEntityId,
      members: [
        member("c1", "a1", { kind: "ATTRIBUTED_STATEMENT", entityId: secretEntityId }),
        member("c2", "a2", { kind: "ATTRIBUTED_STATEMENT", entityId: secretEntityId }),
      ],
    });
    const view = buildCoverageComparisonView({
      articleCount: 2,
      publisherCount: 2,
      claimGroups: [attributedGroup],
      headlineComparison: emptyHeadline,
      articles: [article("a1"), article("a2")],
      hasFullAccess: true,
      hasClaimComparison: true,
    });
    expect(view.claimGroups[0]!.key).not.toContain(secretEntityId);
    expect(JSON.stringify(view)).not.toContain(secretEntityId);
  });
});

describe("empty state", () => {
  it("returns null headlineComparison when there are no headline entries", () => {
    const view = buildCoverageComparisonView({
      articleCount: 0,
      publisherCount: 0,
      claimGroups: [],
      headlineComparison: emptyHeadline,
      articles: [],
      hasFullAccess: true,
      hasClaimComparison: true,
    });
    expect(view.headlineComparison).toBeNull();
    expect(view.claimGroups).toEqual([]);
  });
});
