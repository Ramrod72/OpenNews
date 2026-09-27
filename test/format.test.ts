import { describe, expect, it } from "vitest";
import { absoluteTime, relativeTime, shortTime } from "@/lib/format";

describe("absoluteTime", () => {
  it("renders a clean, human-readable date/time string with a literal 'at' (regression: a former smart-quote in the format string made date-fns misparse it as format tokens, producing garbage like \"'AM1790482408' 4:13 AM\")", () => {
    const result = absoluteTime(new Date("2025-06-01T00:00:00Z"));
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} (AM|PM)$/);
    expect(result).not.toMatch(/['’]/);
  });

  it("accepts a date string as well as a Date object", () => {
    const fromString = absoluteTime("2025-06-01T00:00:00Z");
    const fromDate = absoluteTime(new Date("2025-06-01T00:00:00Z"));
    expect(fromString).toBe(fromDate);
  });
});

describe("shortTime", () => {
  it("renders just the time portion", () => {
    expect(shortTime(new Date("2025-06-01T12:30:00Z"))).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe("relativeTime", () => {
  it("renders a distance-to-now string ending in 'ago'", () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24);
    expect(relativeTime(past)).toMatch(/ago$/);
  });
});
