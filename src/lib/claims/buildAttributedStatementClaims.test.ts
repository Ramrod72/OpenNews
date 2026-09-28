import { describe, expect, it } from "vitest";
import {
  buildAttributedStatementClaims,
  type AttributedStatementSourceObservation,
} from "./buildAttributedStatementClaims";

function obs(
  overrides: Partial<AttributedStatementSourceObservation> = {},
): AttributedStatementSourceObservation {
  return {
    entityId: "ent-reuters",
    startOffset: 0,
    endOffset: 8,
    confidence: "HIGH",
    ...overrides,
  };
}

describe("I — attributed statement from a resolved entity", () => {
  it("builds a claim from the sentence containing the observation's span", () => {
    const text = "Reuters reported the negotiations concluded. The mayor was unavailable.";
    const claims = buildAttributedStatementClaims(text, [obs({ startOffset: 0, endOffset: 8 })]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "ATTRIBUTED_STATEMENT",
      entityId: "ent-reuters",
      rawText: "Reuters reported the negotiations concluded.",
    });
  });
});

describe("L — unresolved entity", () => {
  it("still produces a claim with entityId: null when the observation is unresolved", () => {
    const text = "Officials said the investigation would continue.";
    const claims = buildAttributedStatementClaims(text, [
      obs({ entityId: null, startOffset: 0, endOffset: 15 }),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.entityId).toBeNull();
  });
});

describe("N — duplicate observations in the same article/sentence", () => {
  it("collapses two observations for the SAME entity in the SAME sentence into one claim", () => {
    const text = "Reuters reported the deal and Reuters confirmed the terms.";
    const claims = buildAttributedStatementClaims(text, [
      obs({ startOffset: 0, endOffset: 8 }),
      obs({ startOffset: 31, endOffset: 39 }),
    ]);
    expect(claims).toHaveLength(1);
  });

  it("keeps two observations for DIFFERENT entities in the same sentence as separate claims", () => {
    const text = "Reuters reported that DOJ confirmed the charges.";
    const claims = buildAttributedStatementClaims(text, [
      obs({ entityId: "ent-reuters", startOffset: 0, endOffset: 8 }),
      obs({ entityId: "ent-doj", startOffset: 23, endOffset: 26 }),
    ]);
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((c) => c.entityId))).toEqual(new Set(["ent-reuters", "ent-doj"]));
  });

  it("keeps two observations for the SAME entity in DIFFERENT sentences as separate claims", () => {
    const text = "Reuters reported the deal. Reuters later confirmed the terms in a statement.";
    const claims = buildAttributedStatementClaims(text, [
      obs({ startOffset: 0, endOffset: 8 }),
      obs({ startOffset: 28, endOffset: 36 }),
    ]);
    expect(claims).toHaveLength(2);
  });
});

describe("no observations / empty text", () => {
  it("returns [] when there are no source observations", () => {
    expect(buildAttributedStatementClaims("Reuters reported the news.", [])).toEqual([]);
  });

  it("returns [] for empty text even with observations passed in", () => {
    expect(buildAttributedStatementClaims("", [obs()])).toEqual([]);
  });

  it("skips an observation whose span falls outside every detected sentence", () => {
    const claims = buildAttributedStatementClaims("Reuters reported the news.", [
      obs({ startOffset: 1000, endOffset: 1010 }),
    ]);
    expect(claims).toEqual([]);
  });
});

describe("bounded rawText", () => {
  it("bounds rawText to the configured max length", () => {
    const longSentence = `Reuters reported that ${"word ".repeat(100)}concluded the matter.`;
    const claims = buildAttributedStatementClaims(
      longSentence,
      [obs({ startOffset: 0, endOffset: 8 })],
      { maxRawTextLength: 200 },
    );
    expect(claims[0]!.rawText.length).toBeLessThanOrEqual(201);
  });
});

describe("determinism", () => {
  it("identical input always produces identical output, sorted by position", () => {
    const text = "DOJ confirmed the charges. Reuters reported the story.";
    const observations = [
      obs({ entityId: "ent-reuters", startOffset: 28, endOffset: 36 }),
      obs({ entityId: "ent-doj", startOffset: 0, endOffset: 3 }),
    ];
    const a = buildAttributedStatementClaims(text, observations);
    const b = buildAttributedStatementClaims(text, observations);
    expect(a).toEqual(b);
    expect(a.map((c) => c.entityId)).toEqual(["ent-doj", "ent-reuters"]);
  });
});
