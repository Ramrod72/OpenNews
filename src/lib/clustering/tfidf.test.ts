import { describe, expect, it } from "vitest";
import { averageVectors, buildTfIdfVectors, cosineSimilarity } from "./tfidf";

describe("buildTfIdfVectors + cosineSimilarity", () => {
  it("gives near-identical documents a high similarity score", () => {
    const vectors = buildTfIdfVectors([
      {
        id: "a",
        tokens: ["senate", "passes", "climate", "bill", "senate", "passes", "climate", "bill"],
      },
      {
        id: "b",
        tokens: ["senate", "approves", "climate", "bill", "senate", "approves", "climate", "bill"],
      },
      { id: "c", tokens: ["local", "bakery", "wins", "award"] },
    ]);

    const simAB = cosineSimilarity(vectors.get("a")!, vectors.get("b")!);
    const simAC = cosineSimilarity(vectors.get("a")!, vectors.get("c")!);

    expect(simAB).toBeGreaterThan(0.3);
    expect(simAC).toBe(0);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("returns 0 similarity for an empty document", () => {
    const vectors = buildTfIdfVectors([
      { id: "a", tokens: ["senate", "bill"] },
      { id: "b", tokens: [] },
    ]);
    expect(cosineSimilarity(vectors.get("a")!, vectors.get("b")!)).toBe(0);
  });
});

describe("averageVectors", () => {
  it("averages weights across member vectors", () => {
    const vectors = buildTfIdfVectors([
      { id: "a", tokens: ["senate", "bill"] },
      { id: "b", tokens: ["senate", "vote"] },
    ]);
    const centroid = averageVectors([vectors.get("a")!, vectors.get("b")!]);
    expect(centroid.get("senate")).toBeGreaterThan(0);
    // a term unique to "b" should still be present but weighted down by the average
    expect(centroid.get("vote")).toBeLessThan(vectors.get("b")!.get("vote")!);
  });
});
