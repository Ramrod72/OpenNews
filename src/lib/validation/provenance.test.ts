import { describe, expect, it } from "vitest";
import {
  PERSISTABLE_CONFIDENCE_VALUES,
  PROVENANCE_CONFIDENCE_VALUES,
  isPersistableConfidence,
} from "./provenance";

describe("isPersistableConfidence", () => {
  it("accepts HIGH and MEDIUM", () => {
    expect(isPersistableConfidence("HIGH")).toBe(true);
    expect(isPersistableConfidence("MEDIUM")).toBe(true);
  });

  it("rejects LOW — Phase 7B's locked precision policy (false negative over false positive)", () => {
    expect(isPersistableConfidence("LOW")).toBe(false);
  });

  it("PERSISTABLE_CONFIDENCE_VALUES is a strict subset of PROVENANCE_CONFIDENCE_VALUES that excludes LOW", () => {
    expect(PROVENANCE_CONFIDENCE_VALUES).toContain("LOW");
    expect(PERSISTABLE_CONFIDENCE_VALUES).not.toContain("LOW");
    for (const value of PERSISTABLE_CONFIDENCE_VALUES) {
      expect(PROVENANCE_CONFIDENCE_VALUES as readonly string[]).toContain(value);
    }
  });
});
