import { describe, expect, it } from "vitest";
import { findContainingSentence, splitSentences, MAX_SENTENCES_PER_TEXT } from "./sentenceBoundary";

describe("splitSentences", () => {
  it("splits on ./!/? followed by whitespace and a capital letter", () => {
    const s = splitSentences("Reuters reported the news. The mayor confirmed it. Is that true?");
    expect(s.map((x) => x.text)).toEqual([
      "Reuters reported the news.",
      "The mayor confirmed it.",
      "Is that true?",
    ]);
  });

  it("does not split on a recognized abbreviation's period", () => {
    const s = splitSentences("Dr. Smith said the results were promising. The study continues.");
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toBe("Dr. Smith said the results were promising.");
  });

  it("does not split mid-decimal-number", () => {
    const s = splitSentences("The earthquake measured 7.1 magnitude. Officials responded quickly.");
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain("7.1 magnitude");
  });

  it("returns offsets that round-trip against the original text", () => {
    const text = "Reuters reported the news. The mayor confirmed it.";
    const s = splitSentences(text);
    for (const sentence of s) {
      expect(text.slice(sentence.startOffset, sentence.endOffset).trim()).toBe(sentence.text);
    }
  });

  it("handles empty and whitespace-only input safely", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });

  it("handles text with no terminal punctuation as one sentence", () => {
    const s = splitSentences("Reuters reported the news");
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toBe("Reuters reported the news");
  });

  it("bounds output at MAX_SENTENCES_PER_TEXT for pathological repeated-period input", () => {
    const hostile = "a. ".repeat(500) + "Z.";
    const s = splitSentences(hostile);
    expect(s.length).toBeLessThanOrEqual(MAX_SENTENCES_PER_TEXT);
  });

  it("never throws on malformed punctuation", () => {
    expect(() => splitSentences("???...!!!...")).not.toThrow();
    expect(() => splitSentences('""""""')).not.toThrow();
    expect(() => splitSentences("\u0000\u0001.\u0002")).not.toThrow();
  });
});

describe("findContainingSentence", () => {
  it("finds the sentence containing a given span", () => {
    const text = "Reuters reported the news. The mayor confirmed it.";
    const sentences = splitSentences(text);
    const found = findContainingSentence(sentences, 30, 40);
    expect(found?.text).toBe("The mayor confirmed it.");
  });

  it("returns null for a span outside every sentence", () => {
    const sentences = splitSentences("Reuters reported the news.");
    expect(findContainingSentence(sentences, 1000, 1010)).toBeNull();
  });
});
