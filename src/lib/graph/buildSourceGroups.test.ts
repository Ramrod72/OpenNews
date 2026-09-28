import { describe, expect, it } from "vitest";
import {
  MAX_MERGE_CHAIN_DEPTH,
  buildOriginalReportingSignals,
  buildPrimaryEvidenceGroups,
  buildSharedReportingSourceGroups,
  resolveCanonicalEntityId,
  type ArticleForGrouping,
  type EntityForGrouping,
  type ObservationForGrouping,
} from "./buildSourceGroups";

const REUTERS: EntityForGrouping = {
  id: "ent-reuters",
  canonicalName: "Reuters",
  entityType: "WIRE_SERVICE",
  mergedIntoId: null,
};
const AP: EntityForGrouping = {
  id: "ent-ap",
  canonicalName: "Associated Press",
  entityType: "WIRE_SERVICE",
  mergedIntoId: null,
};

function article(id: string, overrides: Partial<ArticleForGrouping> = {}): ArticleForGrouping {
  return { id, sourceId: `src-${id}`, sourceName: `Source ${id}`, excerpt: null, ...overrides };
}

function obs(
  overrides: Partial<ObservationForGrouping> & { id: string; articleId: string },
): ObservationForGrouping {
  return {
    entityId: null,
    rawEntityText: "Reuters",
    relationshipType: "CITES_WIRE_SERVICE",
    evidenceType: "REPORTING_CITATION",
    confidence: "HIGH",
    evidenceText: "Reuters reported the news.",
    ...overrides,
  };
}

describe("A/D — shared reporting source groups", () => {
  it("A — groups two articles citing Reuters into one SHARED_REPORTING_SOURCE group", () => {
    const articles = [article("a1"), article("a2")];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: REUTERS.id }),
      obs({ id: "o2", articleId: "a2", entityId: REUTERS.id }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entityCanonicalName).toBe("Reuters");
    expect(groups[0]!.confidence).toBe("POSSIBLE");
    expect(groups[0]!.articleIds.sort()).toEqual(["a1", "a2"]);
    expect(groups[0]!.observations).toHaveLength(2);
    // Traceability: every observation ref keeps its evidence, never collapsed away.
    for (const ref of groups[0]!.observations) {
      expect(ref.evidenceText).toBeTruthy();
      expect(ref.observationId).toBeTruthy();
    }
  });

  it("D — keeps Reuters and AP as two separate groups, never merged", () => {
    const articles = [article("a1"), article("a2"), article("a3"), article("a4")];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: REUTERS.id }),
      obs({ id: "o2", articleId: "a2", entityId: REUTERS.id }),
      obs({
        id: "o3",
        articleId: "a3",
        entityId: AP.id,
        rawEntityText: "AP",
        relationshipType: "CITES_WIRE_SERVICE",
        confidence: "MEDIUM",
      }),
      obs({
        id: "o4",
        articleId: "a4",
        entityId: AP.id,
        rawEntityText: "AP",
        relationshipType: "CITES_WIRE_SERVICE",
        confidence: "MEDIUM",
      }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS, AP],
    });

    expect(groups).toHaveLength(2);
    const names = groups.map((g) => g.entityCanonicalName).sort();
    expect(names).toEqual(["Associated Press", "Reuters"]);
    const reutersGroup = groups.find((g) => g.entityCanonicalName === "Reuters")!;
    const apGroup = groups.find((g) => g.entityCanonicalName === "Associated Press")!;
    expect(reutersGroup.articleIds.sort()).toEqual(["a1", "a2"]);
    expect(apGroup.articleIds.sort()).toEqual(["a3", "a4"]);
    // Never labeled anything stronger than POSSIBLE for plain shared citation.
    expect(reutersGroup.confidence).toBe("POSSIBLE");
    expect(apGroup.confidence).toBe("POSSIBLE");
  });

  it("does not create a group for an entity cited by only one article", () => {
    const articles = [article("a1")];
    const observations = [obs({ id: "o1", articleId: "a1", entityId: REUTERS.id })];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS],
    });
    expect(groups).toEqual([]);
  });
});

describe("E/F/T — generic/role-based/anonymous observations are never merged across articles", () => {
  it("E — 'officials said' observations alongside a real Reuters group never form their own group", () => {
    const articles = [article("a1"), article("a2"), article("a3")];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: REUTERS.id }),
      obs({ id: "o2", articleId: "a2", entityId: REUTERS.id }),
      obs({
        id: "o3",
        articleId: "a2",
        entityId: null,
        rawEntityText: "officials said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
        evidenceText: "officials said the response was underway",
      }),
      obs({
        id: "o4",
        articleId: "a3",
        entityId: null,
        rawEntityText: "officials said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
        evidenceText: "officials said the response was underway",
      }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entityCanonicalName).toBe("Reuters");
  });

  it("F — 10 articles all matching bare 'police said' produce NO shared-source group", () => {
    const articles = Array.from({ length: 10 }, (_, i) => article(`a${i}`));
    const observations = articles.map((a, i) =>
      obs({
        id: `o${i}`,
        articleId: a.id,
        entityId: null,
        rawEntityText: "police said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
        evidenceText: "police said the incident was resolved",
      }),
    );
    const groups = buildSharedReportingSourceGroups({ articles, observations, entities: [] });
    expect(groups).toEqual([]);
  });

  it("T — identical evidenceText across articles for unresolved generic roles still never groups", () => {
    const articles = [article("a1"), article("a2"), article("a3")];
    const observations = articles.map((a, i) =>
      obs({
        id: `o${i}`,
        articleId: a.id,
        entityId: null,
        rawEntityText: "a person familiar with the matter said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
        evidenceText: "a person familiar with the matter said the deal was close",
      }),
    );
    const groups = buildSharedReportingSourceGroups({ articles, observations, entities: [] });
    expect(groups).toEqual([]);
  });
});

describe("G — generic primary-evidence phrases never form a strong shared-document group", () => {
  it("two unresolved 'court filing' observations across articles produce no primary evidence group", () => {
    const observations = [
      obs({
        id: "o1",
        articleId: "a1",
        entityId: null,
        rawEntityText: "according to court records",
        relationshipType: "CITES_PRIMARY_DOCUMENT",
        evidenceType: "COURT_FILING",
        confidence: "HIGH",
        evidenceText: "according to court records filed Monday",
      }),
      obs({
        id: "o2",
        articleId: "a2",
        entityId: null,
        rawEntityText: "according to court records",
        relationshipType: "CITES_PRIMARY_DOCUMENT",
        evidenceType: "COURT_FILING",
        confidence: "HIGH",
        evidenceText: "according to court records filed Monday",
      }),
    ];
    const groups = buildPrimaryEvidenceGroups({ observations, entities: [] });
    expect(groups).toEqual([]);
  });

  it("two 'police said' (generic role) observations never form a shared primary-source group", () => {
    const observations = [
      obs({
        id: "o1",
        articleId: "a1",
        entityId: null,
        rawEntityText: "police said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
      }),
      obs({
        id: "o2",
        articleId: "a2",
        entityId: null,
        rawEntityText: "police said",
        relationshipType: "CITES_STATEMENT",
        evidenceType: "STATEMENT",
        confidence: "MEDIUM",
      }),
    ];
    const groups = buildPrimaryEvidenceGroups({ observations, entities: [] });
    expect(groups).toEqual([]);
  });

  it("DOES group primary evidence when two articles genuinely share both resolved entity AND evidenceType (forward-compat path)", () => {
    const court: EntityForGrouping = {
      id: "ent-court",
      canonicalName: "Springfield District Court",
      entityType: "COURT",
      mergedIntoId: null,
    };
    const observations = [
      obs({
        id: "o1",
        articleId: "a1",
        entityId: court.id,
        relationshipType: "CITES_PRIMARY_DOCUMENT",
        evidenceType: "COURT_FILING",
        confidence: "HIGH",
      }),
      obs({
        id: "o2",
        articleId: "a2",
        entityId: court.id,
        relationshipType: "CITES_PRIMARY_DOCUMENT",
        evidenceType: "COURT_FILING",
        confidence: "HIGH",
      }),
    ];
    const groups = buildPrimaryEvidenceGroups({ observations, entities: [court] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe("POSSIBLE"); // never CONFIRMED
    expect(groups[0]!.articleIds.sort()).toEqual(["a1", "a2"]);
  });
});

describe("H — one article's multiple observation types are represented independently, never merged into an article-level claim", () => {
  it("keeps a Reuters citation and an ORIGINAL_REPORTING_CLAIM from the same article as two separate, traceable signals", () => {
    const articles = [article("a1"), article("a2")];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: REUTERS.id }),
      obs({ id: "o2", articleId: "a2", entityId: REUTERS.id }),
      obs({
        id: "o3",
        articleId: "a1",
        entityId: null,
        rawEntityText: "the reporter",
        relationshipType: "ORIGINAL_REPORTING_CLAIM",
        evidenceType: "EYEWITNESS_ACCOUNT",
        confidence: "HIGH",
        evidenceText: "the reporter witnessed the events firsthand",
      }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS],
    });
    const signals = buildOriginalReportingSignals({ articles, observations });

    expect(groups).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.articleId).toBe("a1");
    // Nothing here merges the two into one "article a1 is independently
    // corroborated" claim — they remain two separate, separately-traceable
    // pieces of data with no combined field connecting them.
    expect(groups[0]).not.toHaveProperty("originalReportingSignal");
    expect(signals[0]).not.toHaveProperty("sharedReportingSourceGroup");
  });
});

describe("J — MEDIUM observations are represented honestly, never upgraded", () => {
  it("preserves MEDIUM confidence on the observation ref exactly as stored", () => {
    const articles = [article("a1"), article("a2")];
    const observations = [
      obs({
        id: "o1",
        articleId: "a1",
        entityId: AP.id,
        rawEntityText: "AP",
        confidence: "MEDIUM",
      }),
      obs({
        id: "o2",
        articleId: "a2",
        entityId: AP.id,
        rawEntityText: "AP",
        confidence: "MEDIUM",
      }),
    ];
    const groups = buildSharedReportingSourceGroups({ articles, observations, entities: [AP] });
    expect(groups[0]!.observations.every((o) => o.confidence === "MEDIUM")).toBe(true);
    // The group's own relationship confidence is a SEPARATE field from the
    // underlying observations' own confidence — one MEDIUM observation
    // never gets silently reported as if it were HIGH.
    expect(groups[0]!.confidence).toBe("POSSIBLE");
  });
});

describe("K/L/M — mergedIntoId chain / cycle / pathological-depth handling", () => {
  it("K — resolves a simple chain (A -> B -> C) to the final canonical id", () => {
    const entities: EntityForGrouping[] = [
      { id: "A", canonicalName: "A", entityType: "UNKNOWN", mergedIntoId: "B" },
      { id: "B", canonicalName: "B", entityType: "UNKNOWN", mergedIntoId: "C" },
      { id: "C", canonicalName: "C", entityType: "UNKNOWN", mergedIntoId: null },
    ];
    const byId = new Map(entities.map((e) => [e.id, e]));
    expect(resolveCanonicalEntityId("A", byId)).toBe("C");
    expect(resolveCanonicalEntityId("B", byId)).toBe("C");
    expect(resolveCanonicalEntityId("C", byId)).toBe("C");
  });

  it("groups two articles under the final canonical entity through a merge chain", () => {
    const dojDuplicate: EntityForGrouping = {
      id: "doj-dup",
      canonicalName: "Dept. of Justice (duplicate)",
      entityType: "GOVERNMENT_AGENCY",
      mergedIntoId: "doj-canonical",
    };
    const dojCanonical: EntityForGrouping = {
      id: "doj-canonical",
      canonicalName: "U.S. Department of Justice",
      entityType: "GOVERNMENT_AGENCY",
      mergedIntoId: null,
    };
    const articles = [article("a1"), article("a2")];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: "doj-dup", rawEntityText: "DOJ" }),
      obs({
        id: "o2",
        articleId: "a2",
        entityId: "doj-canonical",
        rawEntityText: "Department of Justice",
      }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [dojDuplicate, dojCanonical],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entityId).toBe("doj-canonical");
    expect(groups[0]!.articleIds.sort()).toEqual(["a1", "a2"]);
    expect(groups[0]!.observations.every((o) => o.entityId === "doj-canonical")).toBe(true);
  });

  it("L — a missing merge target stops resolution safely instead of throwing", () => {
    const entities: EntityForGrouping[] = [
      { id: "A", canonicalName: "A", entityType: "UNKNOWN", mergedIntoId: "does-not-exist" },
    ];
    const byId = new Map(entities.map((e) => [e.id, e]));
    expect(resolveCanonicalEntityId("A", byId)).toBe("A");
  });

  it("M — a two-entity cycle (A -> B -> A) terminates without an infinite loop", () => {
    const entities: EntityForGrouping[] = [
      { id: "A", canonicalName: "A", entityType: "UNKNOWN", mergedIntoId: "B" },
      { id: "B", canonicalName: "B", entityType: "UNKNOWN", mergedIntoId: "A" },
    ];
    const byId = new Map(entities.map((e) => [e.id, e]));
    const resolvedFromA = resolveCanonicalEntityId("A", byId);
    const resolvedFromB = resolveCanonicalEntityId("B", byId);
    // Must terminate (this assertion running at all proves no infinite loop)
    // and stay within the visited entity set, never fabricating a new id.
    expect(["A", "B"]).toContain(resolvedFromA);
    expect(["A", "B"]).toContain(resolvedFromB);
  });

  it("M — a pathologically long non-cyclic chain terminates within MAX_MERGE_CHAIN_DEPTH", () => {
    const chainLength = MAX_MERGE_CHAIN_DEPTH + 50;
    const entities: EntityForGrouping[] = Array.from({ length: chainLength }, (_, i) => ({
      id: `n${i}`,
      canonicalName: `n${i}`,
      entityType: "UNKNOWN" as const,
      mergedIntoId: i < chainLength - 1 ? `n${i + 1}` : null,
    }));
    const byId = new Map(entities.map((e) => [e.id, e]));
    const start = performance.now();
    const resolved = resolveCanonicalEntityId("n0", byId);
    const elapsedMs = performance.now() - start;
    expect(typeof resolved).toBe("string");
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe("N — original reporting signals are exposed as their own list, per-article, never aggregated", () => {
  it("exposes each article's own ORIGINAL_REPORTING_CLAIM with its publisher and evidence intact", () => {
    const articles = [article("a1", { sourceName: "The Local Gazette" })];
    const observations = [
      obs({
        id: "o1",
        articleId: "a1",
        entityId: null,
        rawEntityText: "the reporter",
        relationshipType: "ORIGINAL_REPORTING_CLAIM",
        evidenceType: "EYEWITNESS_ACCOUNT",
        confidence: "HIGH",
        evidenceText: "the reporter witnessed the scene firsthand",
      }),
    ];
    const signals = buildOriginalReportingSignals({ articles, observations });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      articleId: "a1",
      publisherName: "The Local Gazette",
      confidence: "HIGH",
      evidenceText: "the reporter witnessed the scene firsthand",
    });
  });
});

describe("U — same excerpt wording under different resolved entities never collapses into one group", () => {
  it("keeps Reuters and AP groups separate even when their articles' excerpts are near-identical text", () => {
    const articles = [
      article("a1", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
      article("a2", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
      article("a3", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
      article("a4", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
    ];
    const observations = [
      obs({ id: "o1", articleId: "a1", entityId: REUTERS.id }),
      obs({ id: "o2", articleId: "a2", entityId: REUTERS.id }),
      obs({ id: "o3", articleId: "a3", entityId: AP.id, rawEntityText: "AP" }),
      obs({ id: "o4", articleId: "a4", entityId: AP.id, rawEntityText: "AP" }),
    ];
    const groups = buildSharedReportingSourceGroups({
      articles,
      observations,
      entities: [REUTERS, AP],
    });
    expect(groups).toHaveLength(2);
    // Near-duplicate-text comparison never crosses between the two entity
    // groups — a Reuters-group article is never compared against an
    // AP-group article even though the excerpt text is identical.
    for (const group of groups) {
      for (const signal of group.nearDuplicateTextSignals) {
        expect(group.articleIds).toContain(signal.articleIdA);
        expect(group.articleIds).toContain(signal.articleIdB);
      }
    }
  });
});

describe("V — similar articles with zero shared provenance never get an invented relationship", () => {
  it("produces no group at all when neither article has a resolved-entity observation", () => {
    const articles = [
      article("a1", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
      article("a2", {
        excerpt: "Reuters said the storm caused significant damage across the coastline.",
      }),
    ];
    // Neither article has any persisted observation at all.
    const groups = buildSharedReportingSourceGroups({ articles, observations: [], entities: [] });
    expect(groups).toEqual([]);
  });
});
