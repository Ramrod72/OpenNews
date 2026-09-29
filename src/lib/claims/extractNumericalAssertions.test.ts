import { describe, expect, it } from "vitest";
import { extractNumericalAssertions } from "./extractNumericalAssertions";

describe("A/B — basic numerical assertion extraction", () => {
  it("extracts a simple INJURIES assertion", () => {
    const claims = extractNumericalAssertions("Officials said 12 people were injured in the fire.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "NUMERICAL_ASSERTION",
      unit: "INJURIES",
      numericValue: 12,
      qualifier: "EXACT",
      confidence: "HIGH",
    });
  });

  it("extracts DEATHS, ARRESTS, VOTES, ACRES, MILES, KILOMETERS, PERCENT, USD, MAGNITUDE", () => {
    expect(extractNumericalAssertions("5 people were killed in the crash.")[0]).toMatchObject({
      unit: "DEATHS",
      numericValue: 5,
    });
    expect(extractNumericalAssertions("Police confirmed 3 arrests were made.")[0]).toMatchObject({
      unit: "ARRESTS",
      numericValue: 3,
    });
    expect(extractNumericalAssertions("The measure passed with 1,204 votes.")[0]).toMatchObject({
      unit: "VOTES",
      numericValue: 1204,
    });
    expect(extractNumericalAssertions("The fire spread across 500 acres.")[0]).toMatchObject({
      unit: "ACRES",
      numericValue: 500,
    });
    expect(extractNumericalAssertions("The storm moved 15 miles offshore.")[0]).toMatchObject({
      unit: "MILES",
      numericValue: 15,
    });
    expect(extractNumericalAssertions("The epicenter was 20 kilometers away.")[0]).toMatchObject({
      unit: "KILOMETERS",
      numericValue: 20,
    });
    expect(extractNumericalAssertions("Support rose to 63%.")[0]).toMatchObject({
      unit: "PERCENT",
      numericValue: 63,
    });
    expect(extractNumericalAssertions("The deal is worth $4.2 billion.")[0]).toMatchObject({
      unit: "USD",
      numericValue: 4_200_000_000,
    });
    expect(extractNumericalAssertions("The earthquake registered magnitude 7.1.")[0]).toMatchObject(
      {
        unit: "MAGNITUDE",
        numericValue: 7.1,
      },
    );
  });

  it("bare PEOPLE count gets MEDIUM confidence; specific units get HIGH", () => {
    const bare = extractNumericalAssertions("About 40 people attended the rally.");
    expect(bare[0]).toMatchObject({ unit: "PEOPLE", confidence: "MEDIUM" });
    const specific = extractNumericalAssertions("40 people were injured at the rally.");
    expect(specific[0]).toMatchObject({ unit: "INJURIES", confidence: "HIGH" });
  });

  it("does not extract a bare isolated number with no recognized unit", () => {
    const claims = extractNumericalAssertions("The meeting started at 12 and ended late.");
    expect(claims).toHaveLength(0);
  });
});

describe("C/D — unit and predicate distinctions are never collapsed", () => {
  it("same number, different unit are NOT the same extracted claim shape", () => {
    const injured = extractNumericalAssertions("12 people were injured in the incident.")[0]!;
    const arrested = extractNumericalAssertions("12 arrests were made after the incident.")[0]!;
    expect(injured.unit).not.toBe(arrested.unit);
  });

  it("same number, different predicate (injured vs. hospitalized) are never conflated into the same unit", () => {
    // "hospitalized" is not one of the closed-set predicate keywords that
    // anchors INJURIES/DEATHS/ARRESTS — precision over recall: no INJURIES
    // claim is fabricated for it. The bare "N people" fallback rule still
    // matches (any sentence containing "12 people" matches it regardless
    // of predicate), producing a PEOPLE-unit claim — but PEOPLE is a
    // structurally DIFFERENT unit than INJURIES, so grouping (which keys
    // on exact unit match — see buildClaimGroups.ts) can never merge a
    // "12 people were hospitalized" claim with a "12 people were injured"
    // one. This is the actual guarantee the task requires, not that zero
    // claims are extracted.
    const hospitalized = extractNumericalAssertions("12 people were hospitalized after the storm.");
    const injured = extractNumericalAssertions("12 people were injured after the storm.");
    expect(hospitalized[0]?.unit).toBe("PEOPLE");
    expect(injured[0]?.unit).toBe("INJURIES");
    expect(hospitalized[0]?.unit).not.toBe(injured[0]?.unit);
  });
});

describe("E/F — qualifier detection", () => {
  it("detects AT_LEAST, MORE_THAN, AT_MOST, LESS_THAN, APPROXIMATE", () => {
    expect(extractNumericalAssertions("At least 12 people were injured.")[0]).toMatchObject({
      qualifier: "AT_LEAST",
    });
    expect(extractNumericalAssertions("More than 12 people were injured.")[0]).toMatchObject({
      qualifier: "MORE_THAN",
    });
    expect(extractNumericalAssertions("Over 12 people were injured.")[0]).toMatchObject({
      qualifier: "MORE_THAN",
    });
    expect(extractNumericalAssertions("Up to 12 people were injured.")[0]).toMatchObject({
      qualifier: "AT_MOST",
    });
    expect(extractNumericalAssertions("Fewer than 12 people were injured.")[0]).toMatchObject({
      qualifier: "LESS_THAN",
    });
    expect(extractNumericalAssertions("About 12 people were injured.")[0]).toMatchObject({
      qualifier: "APPROXIMATE",
    });
    expect(extractNumericalAssertions("Approximately 12 people were injured.")[0]).toMatchObject({
      qualifier: "APPROXIMATE",
    });
  });

  it("defaults to EXACT when no qualifier phrase is present", () => {
    expect(extractNumericalAssertions("12 people were injured.")[0]).toMatchObject({
      qualifier: "EXACT",
    });
  });

  it("EXACT and AT_LEAST for the same number are structurally distinguishable (never silently equated by this module)", () => {
    const exact = extractNumericalAssertions("12 people were injured.")[0]!;
    const atLeast = extractNumericalAssertions("At least 12 people were injured.")[0]!;
    expect(exact.qualifier).not.toBe(atLeast.qualifier);
    expect(exact.numericValue).toBe(atLeast.numericValue); // same number, different assertion strength
  });
});

describe("G — negation protection", () => {
  it("does not extract a claim from a sentence containing 'no' + the unit noun (no digit present at all)", () => {
    expect(extractNumericalAssertions("Officials said no injuries were reported.")).toHaveLength(0);
    expect(extractNumericalAssertions("No arrests were made.")).toHaveLength(0);
  });

  it("discards a candidate whose containing sentence carries a negation word, even when a number IS present", () => {
    const claims = extractNumericalAssertions("Reports of 3 arrests were not confirmed by police.");
    expect(claims).toHaveLength(0);
  });

  it("a negation word in a DIFFERENT sentence does not suppress an unrelated numeric claim", () => {
    const claims = extractNumericalAssertions(
      "Officials denied the earlier report. 12 people were injured in the fire, authorities confirmed.",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ unit: "INJURIES", numericValue: 12 });
  });
});

describe("H — materially different number is never conflated", () => {
  it("12 and 30 injured produce different numericValue", () => {
    const a = extractNumericalAssertions("12 people were injured.")[0]!;
    const b = extractNumericalAssertions("30 people were injured.")[0]!;
    expect(a.numericValue).not.toBe(b.numericValue);
  });
});

describe("overlap suppression within one sentence", () => {
  it("a more specific unit match suppresses the bare PEOPLE match it contains", () => {
    const claims = extractNumericalAssertions("12 people were injured in the collapse.");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.unit).toBe("INJURIES");
  });
});

describe("hostile/malformed input", () => {
  it("never throws on hostile Unicode, giant digit sequences, or malformed punctuation", () => {
    expect(() => extractNumericalAssertions("𝟏𝟐 people were injured.")).not.toThrow();
    expect(() =>
      extractNumericalAssertions(`${"9".repeat(400)} people were injured.`),
    ).not.toThrow();
    expect(() =>
      extractNumericalAssertions("???...!!! 12 people were injured ...???"),
    ).not.toThrow();
    expect(() => extractNumericalAssertions("‮12 people were injured‬.")).not.toThrow();
  });

  it("bounds an enormous digit sequence rather than producing a non-finite/unbounded numericValue", () => {
    const claims = extractNumericalAssertions(
      `${"9".repeat(400)} people were injured in the fire.`,
    );
    for (const c of claims) {
      expect(Number.isFinite(c.numericValue)).toBe(true);
    }
  });

  it("bounds rawText length even for a very long sentence", () => {
    const longSentence = `${"word ".repeat(200)}12 people were injured in the incident.`;
    const claims = extractNumericalAssertions(longSentence, { maxRawTextLength: 200 });
    expect(claims[0]!.rawText.length).toBeLessThanOrEqual(201); // allow the ellipsis character
  });
});

describe("determinism", () => {
  it("identical input always produces identical output", () => {
    const text = "12 people were injured. 5 people were killed. At least 3 arrests were made.";
    const a = extractNumericalAssertions(text);
    const b = extractNumericalAssertions(text);
    expect(a).toEqual(b);
  });

  it("results are ordered by position in the text", () => {
    const claims = extractNumericalAssertions(
      "5 people were killed. 12 people were injured. 3 arrests were made.",
    );
    expect(claims.map((c) => c.unit)).toEqual(["DEATHS", "INJURIES", "ARRESTS"]);
  });
});

describe("empty input", () => {
  it("returns [] for empty/whitespace-only text", () => {
    expect(extractNumericalAssertions("")).toEqual([]);
    expect(extractNumericalAssertions("   ")).toEqual([]);
  });
});

describe("negative values and numeric ranges never silently collapse to one false-precise value", () => {
  // Found during the final adversarial merge-gate review: a "-" (or en/em
  // dash) immediately adjacent to the matched digit run — either a
  // hostile negative sign our unit rules don't support, or an ordinary
  // written-out range like "10-12 people" — used to be silently dropped,
  // presenting the second number of a range (or the unsigned magnitude of
  // a negative value) as if it were the sole exact assertion the text
  // made. Precision over recall requires refusing extraction instead.
  it("refuses to extract a hostile leading minus sign", () => {
    expect(extractNumericalAssertions("-5 people were injured.")).toEqual([]);
  });

  it("refuses to extract either end of a hyphenated numeric range", () => {
    expect(extractNumericalAssertions("10-12 people were injured.")).toEqual([]);
  });

  it("refuses to extract either end of an en-dash numeric range", () => {
    expect(extractNumericalAssertions("10–12 people were injured.")).toEqual([]);
  });

  it("still extracts normally when a hyphen precedes an unrelated word, not the digit itself", () => {
    const claims = extractNumericalAssertions("A well-known 12 people attended the event.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ unit: "PEOPLE", numericValue: 12 });
  });
});
