import { describe, expect, it } from "vitest";
import { extractKeywordPhrases } from "./keywords";

describe("extractKeywordPhrases", () => {
  it("extracts multi-word proper noun phrases", () => {
    const phrases = extractKeywordPhrases("New York Times reports on European Union summit");
    expect(phrases).toContain("New York Times");
    expect(phrases).toContain("European Union");
  });

  it("extracts single capitalized entities like acronyms", () => {
    const phrases = extractKeywordPhrases("NASA confirms new mission to Europa");
    expect(phrases).toContain("NASA");
    expect(phrases).toContain("Europa");
  });

  it("drops a leading common word from a phrase", () => {
    const phrases = extractKeywordPhrases("The White House announces new policy");
    expect(phrases).toContain("White House");
    expect(phrases).not.toContain("The White House");
  });

  it("does not treat a sentence-initial common word alone as a keyword", () => {
    const phrases = extractKeywordPhrases("The market fell sharply today");
    expect(phrases).not.toContain("The");
  });

  it("returns an empty list for titles with no capitalized phrases", () => {
    expect(extractKeywordPhrases("the market fell sharply today")).toEqual([]);
  });
});
