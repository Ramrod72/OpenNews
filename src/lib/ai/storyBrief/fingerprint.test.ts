import { describe, expect, it } from "vitest";
import { fingerprintAiStoryBriefInput } from "./fingerprint";
import type { AiStoryBriefInput } from "./input";

function input(overrides: Partial<AiStoryBriefInput> = {}): AiStoryBriefInput {
  return {
    headline: "Test story",
    articleCount: 3,
    publisherCount: 2,
    notDetectedCount: 0,
    originalReportingCount: 0,
    claimGroups: [],
    sourceGroups: [],
    headlines: [],
    sharedHeadlineEntities: [],
    limitationsNote: "note",
    ...overrides,
  };
}

describe("fingerprintAiStoryBriefInput", () => {
  it("is deterministic for identical input", () => {
    const a = fingerprintAiStoryBriefInput(input());
    const b = fingerprintAiStoryBriefInput(input());
    expect(a).toBe(b);
  });

  it("changes when a claim group is added (new article entering the cluster)", () => {
    const before = fingerprintAiStoryBriefInput(input());
    const after = fingerprintAiStoryBriefInput(
      input({
        claimGroups: [
          {
            ref: "CLAIM-GROUP-1",
            kind: "NUMERICAL_ASSERTION",
            text: "12 injured",
            articleCount: 2,
            publisherCount: 2,
            sourceOverlapRefs: [],
          },
        ],
      }),
    );
    expect(before).not.toBe(after);
  });

  it("changes when article/publisher counts change", () => {
    const a = fingerprintAiStoryBriefInput(input({ articleCount: 3 }));
    const b = fingerprintAiStoryBriefInput(input({ articleCount: 4 }));
    expect(a).not.toBe(b);
  });

  it("is a 64-character hex sha256 digest", () => {
    const fp = fingerprintAiStoryBriefInput(input());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
