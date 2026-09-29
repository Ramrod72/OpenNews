import { describe, expect, it } from "vitest";
import {
  buildAiStoryBriefInput,
  collectValidReferences,
  isInputTooSparse,
  MAX_CLAIM_GROUPS_FOR_AI,
  MAX_HEADLINES_FOR_AI,
  MAX_SOURCE_GROUPS_FOR_AI,
} from "./input";
import type { CoverageComparisonView } from "@/lib/coverageComparisonView";
import type { StoryIntelligenceView } from "@/lib/storyIntelligenceView";

function baseCoverage(overrides: Partial<CoverageComparisonView> = {}): CoverageComparisonView {
  return {
    status: "ok",
    hasFullAccess: true,
    hasClaimComparison: true,
    articleCount: 4,
    publisherCount: 3,
    claimGroups: [],
    totalClaimGroupCount: 0,
    headlineComparison: null,
    limitationsNote: "Comparisons are based on the article text available to Veriqen.",
    ...overrides,
  };
}

const noIntelligence: StoryIntelligenceView = {
  status: "ok",
  articleCount: 4,
  publisherCount: 3,
  hasFullAccess: true,
  reportingSourceGroups: [],
  totalReportingSourceGroupCount: 0,
  originalReporting: null,
  sourcingNotDetectedCount: 2,
};

describe("buildAiStoryBriefInput", () => {
  it("never includes an internal DB id anywhere in the built input", () => {
    const coverage = baseCoverage({
      claimGroups: [
        {
          key: "k1",
          kind: "NUMERICAL_ASSERTION",
          text: "12 people were injured",
          articleCount: 3,
          publisherCount: 3,
          numericUnit: "INJURIES",
          numericValue: 12,
          numericQualifier: "EXACT",
          sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
        },
      ],
      totalClaimGroupCount: 1,
    });
    const input = buildAiStoryBriefInput({
      headline: "Test story",
      coverage,
      intelligence: noIntelligence,
    });
    const json = JSON.stringify(input);
    expect(json).not.toMatch(/cm[a-z0-9]{20,}/i); // cuid-shaped strings
    expect(input.claimGroups[0]!.ref).toBe("CLAIM-GROUP-1");
    expect(input.sourceGroups[0]!.ref).toBe("SOURCE-GROUP-1");
    expect(input.sourceGroups[0]!.entityName).toBe("Reuters");
    expect(input.claimGroups[0]!.sourceOverlapRefs).toEqual(["SOURCE-GROUP-1"]);
  });

  it("caps claim groups, source groups, and headlines at their bounds", () => {
    const coverage = baseCoverage({
      claimGroups: Array.from({ length: 30 }, (_, i) => ({
        key: `k${i}`,
        kind: "NUMERICAL_ASSERTION" as const,
        text: `${i} people were injured`,
        articleCount: 2,
        publisherCount: 2,
        sourceOverlap: [{ entityName: `Entity-${i}`, overlapArticleCount: 2 }],
      })),
      headlineComparison: {
        entries: Array.from({ length: 30 }, (_, i) => ({
          articleId: `a${i}`,
          title: `Headline ${i}`,
          url: `https://example.com/${i}`,
          publisherName: `Source ${i}`,
          publisherSourceId: `src-${i}`,
          entities: [],
          perspective: "reporting" as const,
        })),
        sharedEntities: [],
        truncated: false,
      },
    });
    const input = buildAiStoryBriefInput({ headline: "Test", coverage, intelligence: null });
    expect(input.claimGroups.length).toBeLessThanOrEqual(MAX_CLAIM_GROUPS_FOR_AI);
    expect(input.sourceGroups.length).toBeLessThanOrEqual(MAX_SOURCE_GROUPS_FOR_AI);
    expect(input.headlines.length).toBeLessThanOrEqual(MAX_HEADLINES_FOR_AI);
  });

  it("deduplicates the same source-overlap entity across multiple claim groups into one ref", () => {
    const coverage = baseCoverage({
      claimGroups: [
        {
          key: "k1",
          kind: "NUMERICAL_ASSERTION",
          text: "a",
          articleCount: 2,
          publisherCount: 2,
          sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
        },
        {
          key: "k2",
          kind: "ATTRIBUTED_STATEMENT",
          text: "b",
          articleCount: 2,
          publisherCount: 2,
          sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
        },
      ],
    });
    const input = buildAiStoryBriefInput({ headline: "Test", coverage, intelligence: null });
    expect(input.sourceGroups).toHaveLength(1);
    expect(input.claimGroups[0]!.sourceOverlapRefs).toEqual(["SOURCE-GROUP-1"]);
    expect(input.claimGroups[1]!.sourceOverlapRefs).toEqual(["SOURCE-GROUP-1"]);
  });

  it("truncates overly long text fields", () => {
    const coverage = baseCoverage({ headline: "x".repeat(500) } as never);
    const input = buildAiStoryBriefInput({
      headline: "x".repeat(500),
      coverage,
      intelligence: null,
    });
    expect(input.headline.length).toBeLessThanOrEqual(200);
  });
});

describe("collectValidReferences", () => {
  it("returns exactly the refs present in claimGroups/sourceGroups/headlines", () => {
    const input = buildAiStoryBriefInput({
      headline: "Test",
      coverage: baseCoverage({
        claimGroups: [
          {
            key: "k1",
            kind: "NUMERICAL_ASSERTION",
            text: "a",
            articleCount: 2,
            publisherCount: 2,
            sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
          },
        ],
        headlineComparison: {
          entries: [
            {
              articleId: "a1",
              title: "H1",
              url: "https://example.com/1",
              publisherName: "Source 1",
              publisherSourceId: "src-1",
              entities: [],
              perspective: "reporting",
            },
          ],
          sharedEntities: [],
          truncated: false,
        },
      }),
      intelligence: null,
    });
    const refs = collectValidReferences(input);
    expect(refs).toEqual(new Set(["CLAIM-GROUP-1", "SOURCE-GROUP-1", "HEADLINE-1"]));
  });
});

describe("isInputTooSparse", () => {
  it("is true with zero claim groups and zero/identical headlines", () => {
    const input = buildAiStoryBriefInput({
      headline: "Test",
      coverage: baseCoverage(),
      intelligence: null,
    });
    expect(isInputTooSparse(input)).toBe(true);
  });

  it("is false when there is at least one claim group", () => {
    const input = buildAiStoryBriefInput({
      headline: "Test",
      coverage: baseCoverage({
        claimGroups: [
          {
            key: "k1",
            kind: "NUMERICAL_ASSERTION",
            text: "a",
            articleCount: 2,
            publisherCount: 2,
            sourceOverlap: [],
          },
        ],
      }),
      intelligence: null,
    });
    expect(isInputTooSparse(input)).toBe(false);
  });

  it("is false when headlines genuinely differ", () => {
    const input = buildAiStoryBriefInput({
      headline: "Test",
      coverage: baseCoverage({
        headlineComparison: {
          entries: [
            {
              articleId: "a1",
              title: "Headline A",
              url: "https://example.com/1",
              publisherName: "S1",
              publisherSourceId: "s1",
              entities: [],
              perspective: "reporting",
            },
            {
              articleId: "a2",
              title: "Headline B",
              url: "https://example.com/2",
              publisherName: "S2",
              publisherSourceId: "s2",
              entities: [],
              perspective: "reporting",
            },
          ],
          sharedEntities: [],
          truncated: false,
        },
      }),
      intelligence: null,
    });
    expect(isInputTooSparse(input)).toBe(false);
  });
});
