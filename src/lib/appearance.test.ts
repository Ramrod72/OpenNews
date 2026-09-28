import { describe, expect, it } from "vitest";
import {
  APPEARANCE_DESCRIPTIONS,
  APPEARANCE_LABELS,
  APPEARANCE_VALUES,
  isValidAppearancePreference,
} from "./appearance";

describe("APPEARANCE_VALUES", () => {
  it("is exactly system, light, dark — in that order, System first as the default", () => {
    expect(APPEARANCE_VALUES).toEqual(["system", "light", "dark"]);
  });

  it("every value has a label and a description — no gaps if the list ever changes", () => {
    for (const value of APPEARANCE_VALUES) {
      expect(APPEARANCE_LABELS[value]).toBeTruthy();
      expect(APPEARANCE_DESCRIPTIONS[value]).toBeTruthy();
    }
  });
});

describe("isValidAppearancePreference", () => {
  it("accepts every real appearance value", () => {
    for (const value of APPEARANCE_VALUES) {
      expect(isValidAppearancePreference(value)).toBe(true);
    }
  });

  it("rejects a corrupted/hand-edited localStorage value — this is exactly what ThemeSanitizer checks before resetting to system", () => {
    for (const bad of ["xyz", "System", "LIGHT", "", "true", "null", "undefined", " light"]) {
      expect(isValidAppearancePreference(bad)).toBe(false);
    }
  });

  it("rejects non-string values (undefined, null, numbers, objects)", () => {
    for (const bad of [undefined, null, 0, 1, {}, [], true]) {
      expect(isValidAppearancePreference(bad)).toBe(false);
    }
  });
});
