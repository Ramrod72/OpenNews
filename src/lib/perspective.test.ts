import { describe, expect, it } from "vitest";
import { classifyPerspective } from "./perspective";

describe("classifyPerspective", () => {
  it("classifies articles under an /opinion/ path as opinion", () => {
    expect(
      classifyPerspective({
        url: "https://example.com/opinion/why-this-matters",
        title: "Why this matters",
      }),
    ).toBe("opinion");
  });

  it("classifies an 'Opinion:' prefixed title as opinion", () => {
    expect(
      classifyPerspective({
        url: "https://example.com/news/story-1",
        title: "Opinion: The case for reform",
      }),
    ).toBe("opinion");
  });

  it("classifies an /analysis/ path as analysis", () => {
    expect(
      classifyPerspective({
        url: "https://example.com/analysis/market-trends",
        title: "Market trends",
      }),
    ).toBe("analysis");
  });

  it("defaults to reporting when no signal is present", () => {
    expect(
      classifyPerspective({
        url: "https://example.com/world/story-1",
        title: "Officials confirm details",
      }),
    ).toBe("reporting");
  });

  it("is case-insensitive", () => {
    expect(
      classifyPerspective({ url: "https://example.com/OPINION/piece", title: "Some piece" }),
    ).toBe("opinion");
  });
});
