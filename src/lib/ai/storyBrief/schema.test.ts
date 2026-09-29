import { describe, expect, it } from "vitest";
import {
  appendServerLimitations,
  MAX_ARRAY_ITEMS,
  MAX_ITEM_CHARS,
  MAX_RAW_OUTPUT_CHARS,
  MAX_SUMMARY_CHARS,
  validateAiStoryBriefOutput,
} from "./schema";

const validRefs = new Set(["CLAIM-GROUP-1", "CLAIM-GROUP-2", "SOURCE-GROUP-1", "HEADLINE-1"]);

function validPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: { text: "Multiple articles report a similar figure.", refs: ["CLAIM-GROUP-1"] },
    commonAssertions: [{ text: "12 people were injured.", refs: ["CLAIM-GROUP-1"] }],
    coverageDifferences: [
      { text: "One outlet reports a different figure.", refs: ["CLAIM-GROUP-2"] },
    ],
    sourceOverlapNotes: [{ text: "Some articles cite the same source.", refs: ["SOURCE-GROUP-1"] }],
    unresolvedQuestions: [{ text: "Some details are not detected in the available text." }],
    ...overrides,
  });
}

describe("A/B — happy path", () => {
  it("accepts a well-formed, fully-grounded payload", () => {
    const result = validateAiStoryBriefOutput(validPayload(), validRefs);
    expect(result.ok).toBe(true);
  });
});

describe("malformed JSON", () => {
  it("rejects non-JSON text", () => {
    const result = validateAiStoryBriefOutput("not json at all {{{", validRefs);
    expect(result).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects a JSON array at the top level", () => {
    const result = validateAiStoryBriefOutput("[]", validRefs);
    expect(result.ok).toBe(false);
  });
});

describe("unknown fields", () => {
  it("rejects an unexpected top-level field", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      extraField: "hello",
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "unknown_field", detail: "extraField" });
  });

  it("rejects a model-supplied limitations field (server-templated only)", () => {
    const raw = JSON.stringify({ ...JSON.parse(validPayload()), limitations: ["fake"] });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "unknown_field", detail: "limitations" });
  });

  it("rejects an unexpected field inside a statement object", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "x", refs: ["CLAIM-GROUP-1"], extra: 1 },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "unknown_field", detail: "extra" });
  });
});

describe("oversized fields/arrays/response", () => {
  it("rejects a raw response longer than MAX_RAW_OUTPUT_CHARS", () => {
    const huge = "x".repeat(MAX_RAW_OUTPUT_CHARS + 1);
    const result = validateAiStoryBriefOutput(huge, validRefs);
    expect(result).toEqual({ ok: false, reason: "oversized_response" });
  });

  it("rejects a summary.text longer than MAX_SUMMARY_CHARS", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "x".repeat(MAX_SUMMARY_CHARS + 1), refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "field_too_long" });
  });

  it("accepts a summary.text longer than MAX_ITEM_CHARS but within MAX_SUMMARY_CHARS (regression: summary must not be capped at the per-item item-array limit)", () => {
    expect(MAX_ITEM_CHARS).toBeLessThan(MAX_SUMMARY_CHARS); // guards the premise of this test itself
    const length = MAX_ITEM_CHARS + 50;
    expect(length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "x".repeat(length), refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result.ok).toBe(true);
  });

  it("rejects an item text longer than MAX_ITEM_CHARS", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      commonAssertions: [{ text: "x".repeat(MAX_ITEM_CHARS + 1), refs: ["CLAIM-GROUP-1"] }],
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "field_too_long" });
  });

  it("rejects an array longer than MAX_ARRAY_ITEMS", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      commonAssertions: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, () => ({
        text: "a",
        refs: ["CLAIM-GROUP-1"],
      })),
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "array_too_long" });
  });
});

describe("hallucinated / missing references", () => {
  it("rejects a ref that looks valid in shape but was never in the server's reference set", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "x", refs: ["CLAIM-GROUP-99"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported_reference",
      detail: "CLAIM-GROUP-99",
    });
  });

  it("rejects a summary with an empty refs array", () => {
    const raw = JSON.stringify({ ...JSON.parse(validPayload()), summary: { text: "x", refs: [] } });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "missing_refs" });
  });

  it("rejects a commonAssertions item with no refs", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      commonAssertions: [{ text: "x", refs: [] }],
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "missing_refs" });
  });

  it("does not require refs on unresolvedQuestions", () => {
    const result = validateAiStoryBriefOutput(validPayload(), validRefs);
    expect(result.ok).toBe(true);
  });
});

describe("forbidden language (runtime, independent of the prompt)", () => {
  const forbiddenExamples = [
    "3 sources confirmed the account.",
    "This has been verified by officials.",
    "The reports are corroborated.",
    "9 sources independently confirmed this.",
    "This is true.",
    "This is false.",
    "One outlet is lying about the figures.",
    "This proves the claim.",
    "This disproves the claim.",
    "This looks like propaganda.",
    "The outlet is biased.",
    "This source is reliable.",
    "This source is unreliable.",
    "The article omitted the death toll.",
    "The outlet hid the number.",
    "The outlet failed to report the figure.",
    "Both articles appear to use the same dispatch.",
    "The text was copied from another outlet.",
    "This paragraph was plagiarized.",
  ];

  it.each(forbiddenExamples)("rejects model output containing: %s", (sentence) => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: sentence, refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "forbidden_language" });
  });

  it("also checks commonAssertions/coverageDifferences/sourceOverlapNotes/unresolvedQuestions, not just summary", () => {
    for (const field of ["commonAssertions", "coverageDifferences", "sourceOverlapNotes"]) {
      const raw = JSON.stringify({
        ...JSON.parse(validPayload()),
        [field]: [{ text: "This is confirmed.", refs: ["CLAIM-GROUP-1"] }],
      });
      const result = validateAiStoryBriefOutput(raw, validRefs);
      expect(result).toMatchObject({ ok: false, reason: "forbidden_language" });
    }
    const rawUnresolved = JSON.stringify({
      ...JSON.parse(validPayload()),
      unresolvedQuestions: [{ text: "It remains unverified." }],
    });
    expect(validateAiStoryBriefOutput(rawUnresolved, validRefs)).toMatchObject({
      ok: false,
      reason: "forbidden_language",
    });
  });
});

describe("unsupported URLs in model output", () => {
  it("rejects a URL embedded in generated text", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "See https://evil.example.com for more.", refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "unsupported_url" });
  });

  it("rejects a javascript: scheme in generated text", () => {
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "javascript:alert(1) is mentioned here.", refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result).toMatchObject({ ok: false, reason: "unsupported_url" });
  });
});

describe("HTML/script in model output", () => {
  it("does not execute or specially interpret embedded HTML — the text is accepted as literal text if otherwise valid, never rendered as markup by this layer", () => {
    // Validation itself is not an XSS boundary (that's the plain-React-text
    // rendering layer, structurally tested in the safety suite) — this
    // test documents that hostile HTML in an otherwise-valid statement is
    // preserved verbatim as plain text, not stripped or executed here.
    const raw = JSON.stringify({
      ...JSON.parse(validPayload()),
      summary: { text: "Test <script>alert(1)</script> value", refs: ["CLAIM-GROUP-1"] },
    });
    const result = validateAiStoryBriefOutput(raw, validRefs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.summary.text).toContain("<script>");
  });
});

describe("appendServerLimitations", () => {
  it("always uses the server-provided limitationsNote, never anything from the model", () => {
    const result = validateAiStoryBriefOutput(validPayload(), validRefs);
    if (!result.ok) throw new Error("expected ok");
    const output = appendServerLimitations(result.output, "SERVER NOTE");
    expect(output.limitations[0]).toBe("SERVER NOTE");
  });
});
