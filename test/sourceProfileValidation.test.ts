import { describe, expect, it } from "vitest";
import {
  externalAssessmentSchema,
  sourceProfileSchema,
  ASSESSMENT_TYPE_VALUES,
  SOURCE_TYPE_VALUES,
} from "@/lib/validation/sourceProfile";

describe("sourceProfileSchema", () => {
  it("accepts an empty object — every field is optional", () => {
    expect(sourceProfileSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully populated valid profile", () => {
    const result = sourceProfileSchema.safeParse({
      description: "A synthetic test publisher.",
      sourceType: "newspaper",
      country: "Testland",
      ownership: "Example Media Group",
      foundedYear: 1990,
      homepageUrl: "https://example.com",
      logoUrl: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
  });

  it("treats an empty string the same as omitted for optional text fields", () => {
    const result = sourceProfileSchema.safeParse({ description: "", country: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
      expect(result.data.country).toBeUndefined();
    }
  });

  it("rejects an unknown sourceType value", () => {
    expect(sourceProfileSchema.safeParse({ sourceType: "tabloid_conspiracy" }).success).toBe(false);
  });

  it("accepts every declared SOURCE_TYPE_VALUES entry", () => {
    for (const value of SOURCE_TYPE_VALUES) {
      expect(sourceProfileSchema.safeParse({ sourceType: value }).success).toBe(true);
    }
  });

  it("rejects a foundedYear before 1000", () => {
    expect(sourceProfileSchema.safeParse({ foundedYear: 999 }).success).toBe(false);
  });

  it("rejects a foundedYear in the future", () => {
    const nextYear = new Date().getFullYear() + 1;
    expect(sourceProfileSchema.safeParse({ foundedYear: nextYear }).success).toBe(false);
  });

  it("rejects a non-integer foundedYear", () => {
    expect(sourceProfileSchema.safeParse({ foundedYear: 1990.5 }).success).toBe(false);
  });

  it("rejects a homepageUrl that isn't http(s)", () => {
    expect(sourceProfileSchema.safeParse({ homepageUrl: "javascript:alert(1)" }).success).toBe(
      false,
    );
    expect(sourceProfileSchema.safeParse({ homepageUrl: "ftp://example.com" }).success).toBe(false);
  });

  it("rejects a malformed homepageUrl", () => {
    expect(sourceProfileSchema.safeParse({ homepageUrl: "not a url" }).success).toBe(false);
  });

  it("rejects a logoUrl that isn't http(s)", () => {
    expect(
      sourceProfileSchema.safeParse({ logoUrl: "data:text/html,<script>alert(1)</script>" })
        .success,
    ).toBe(false);
  });

  it("rejects a description longer than the max length", () => {
    expect(sourceProfileSchema.safeParse({ description: "a".repeat(2001) }).success).toBe(false);
  });

  it("rejects a homepageUrl carrying embedded credentials (user:pass@host)", () => {
    expect(
      sourceProfileSchema.safeParse({ homepageUrl: "https://user:pass@evil.example.com" }).success,
    ).toBe(false);
  });

  it("rejects a homepageUrl using a deceptive userinfo segment (looks like one host, resolves to another)", () => {
    // The visible/copyable text names "legit-looking.example.com" but a
    // browser actually navigates to "attacker.example.com" — the classic
    // `https://trusted-looking@evil-host` phishing pattern.
    expect(
      sourceProfileSchema.safeParse({
        homepageUrl: "https://legit-looking.example.com@attacker.example.com",
      }).success,
    ).toBe(false);
  });

  it("rejects a logoUrl carrying embedded credentials", () => {
    expect(
      sourceProfileSchema.safeParse({ logoUrl: "https://user:pass@evil.example.com/logo.png" })
        .success,
    ).toBe(false);
  });
});

describe("externalAssessmentSchema", () => {
  const valid = {
    provider: "Example Rating Institute (synthetic)",
    assessmentType: "political_lean",
    ratingValue: "Lean left",
  };

  it("accepts the minimal required fields", () => {
    expect(externalAssessmentSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a non-empty provider", () => {
    expect(externalAssessmentSchema.safeParse({ ...valid, provider: "" }).success).toBe(false);
  });

  it("requires a non-empty ratingValue", () => {
    expect(externalAssessmentSchema.safeParse({ ...valid, ratingValue: "" }).success).toBe(false);
  });

  it("rejects an unknown assessmentType", () => {
    expect(externalAssessmentSchema.safeParse({ ...valid, assessmentType: "vibes" }).success).toBe(
      false,
    );
  });

  it("accepts every declared ASSESSMENT_TYPE_VALUES entry", () => {
    for (const value of ASSESSMENT_TYPE_VALUES) {
      expect(externalAssessmentSchema.safeParse({ ...valid, assessmentType: value }).success).toBe(
        true,
      );
    }
  });

  it("rejects a referenceUrl that isn't http(s)", () => {
    expect(
      externalAssessmentSchema.safeParse({ ...valid, referenceUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("accepts a valid referenceUrl", () => {
    expect(
      externalAssessmentSchema.safeParse({
        ...valid,
        referenceUrl: "https://rating-institute.example.com/report",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid assessedAt date string", () => {
    expect(externalAssessmentSchema.safeParse({ ...valid, assessedAt: "not-a-date" }).success).toBe(
      false,
    );
  });

  it("accepts a valid ISO assessedAt date string", () => {
    const result = externalAssessmentSchema.safeParse({
      ...valid,
      assessedAt: "2025-06-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("treats an empty assessedAt string as not provided", () => {
    const result = externalAssessmentSchema.safeParse({ ...valid, assessedAt: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assessedAt).toBeUndefined();
  });

  it("rejects a provider longer than the max length", () => {
    expect(
      externalAssessmentSchema.safeParse({ ...valid, provider: "a".repeat(201) }).success,
    ).toBe(false);
  });

  it("rejects a referenceUrl carrying embedded credentials or a deceptive userinfo host", () => {
    expect(
      externalAssessmentSchema.safeParse({
        ...valid,
        referenceUrl: "https://user:pass@evil.example.com/report",
      }).success,
    ).toBe(false);
    expect(
      externalAssessmentSchema.safeParse({
        ...valid,
        referenceUrl: "https://rating-institute.example.com@attacker.example.com/report",
      }).success,
    ).toBe(false);
  });
});
