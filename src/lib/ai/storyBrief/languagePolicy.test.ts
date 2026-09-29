import { describe, expect, it } from "vitest";
import { containsForbiddenLanguage, findForbiddenLanguage } from "./languagePolicy";

describe("findForbiddenLanguage", () => {
  const forbidden = [
    "confirmed",
    "Confirmed",
    "confirming",
    "verified",
    "unverified",
    "verification",
    "corroborated",
    "independently confirmed",
    "true",
    "false",
    "lies",
    "lying",
    "proved",
    "disproved",
    "propaganda",
    "biased",
    "reliable",
    "unreliable",
    "omitted",
    "hidden",
    "failed to report",
    "same dispatch",
    "copied",
    "plagiarized",
    "plagiarised",
  ];

  it.each(forbidden)("flags %s", (word) => {
    expect(findForbiddenLanguage(`The article said this was ${word} today.`)).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(findForbiddenLanguage("CONFIRMED")).not.toBeNull();
  });

  it("does not flag ordinary descriptive coverage language", () => {
    const safe = [
      "12 people were injured according to officials.",
      "This story appears in 15 articles.",
      "9 of these articles cite Reuters.",
      "One outlet reports a higher figure than another.",
      "This assertion was not detected in the available text.",
    ];
    for (const text of safe) {
      expect(containsForbiddenLanguage(text)).toBe(false);
    }
  });
});
