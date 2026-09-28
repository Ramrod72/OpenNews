import { describe, expect, it } from "vitest";
import {
  MAX_ARTICLES_PER_GROUP_DISPLAY,
  MAX_EVIDENCE_ITEMS_PER_GROUP,
  MAX_EVIDENCE_PER_ARTICLE,
  MAX_FREE_REPORTING_GROUPS,
  buildStoryIntelligenceView,
  type StoryIntelligenceView,
  type ViewArticle,
} from "./storyIntelligenceView";
import type {
  ClusterOriginSummary,
  ObservationRef,
  SharedReportingSourceGroup,
} from "@/lib/graph/types";

/**
 * Phase 9B: tests for the ONE safe boundary between Phase 8's internal
 * ClusterOriginSummary and anything ever rendered/serialized to a
 * viewer. These specifically prove: (1) the view model never contains a
 * forbidden internal identifier, regardless of entitlement, and (2) a
 * non-entitled viewer's view model never contains premium evidence/
 * article data, not merely that a UI layer would hide it.
 */

const FORBIDDEN_KEYS = [
  "observationId",
  "entityId",
  "extractorVersion",
  "reviewState",
  "dedupeKey",
  "startOffset",
  "endOffset",
  "ADMIN_OVERRIDE",
  "mergedIntoId",
];

function article(id: string, overrides: Partial<ViewArticle> = {}): ViewArticle {
  return {
    id,
    title: `Article ${id}`,
    url: `https://example.com/${id}`,
    source: { id: `src-${id}`, name: `Source ${id}` },
    ...overrides,
  };
}

function observation(
  overrides: Partial<ObservationRef> & { observationId: string; articleId: string },
): ObservationRef {
  return {
    entityId: "ent-1",
    relationshipType: "CITES_WIRE_SERVICE",
    evidenceType: "REPORTING_CITATION",
    confidence: "HIGH",
    rawEntityText: "Reuters",
    evidenceText: "Reuters reported the news.",
    ...overrides,
  };
}

function reutersGroup(
  overrides: Partial<SharedReportingSourceGroup> = {},
): SharedReportingSourceGroup {
  return {
    groupType: "SHARED_REPORTING_SOURCE",
    entityId: "ent-reuters",
    entityCanonicalName: "Reuters",
    entityType: "WIRE_SERVICE",
    confidence: "POSSIBLE",
    articleIds: ["a1", "a2"],
    observations: [
      observation({ observationId: "o1", articleId: "a1" }),
      observation({ observationId: "o2", articleId: "a2" }),
    ],
    nearDuplicateTextSignals: [],
    ...overrides,
  };
}

function summary(overrides: Partial<ClusterOriginSummary> = {}): ClusterOriginSummary {
  return {
    clusterId: "c1",
    articleCount: 2,
    publisherCount: 2,
    sharedReportingSourceGroups: [reutersGroup()],
    primaryEvidenceGroups: [],
    originalReportingSignals: [],
    unresolvedArticleCount: 0,
    provenanceCoverage: { articlesWithDetectedProvenance: 2, articlesWithoutDetectedProvenance: 0 },
    ...overrides,
  };
}

function assertNoForbiddenKeys(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN_KEYS) {
    expect(json).not.toContain(key);
  }
}

describe("A — Reuters shared reporting source", () => {
  it("produces one reporting_intermediary group for a Reuters citation", () => {
    const articles = [article("a1"), article("a2")];
    const view = buildStoryIntelligenceView(summary(), articles, true);
    expect(view.reportingSourceGroups).toHaveLength(1);
    expect(view.reportingSourceGroups[0]).toMatchObject({
      entityName: "Reuters",
      kind: "reporting_intermediary",
      articleCount: 2,
    });
  });
});

describe("B — AP remains a separate group from Reuters", () => {
  it("keeps two distinct groups, never merged", () => {
    const apGroup = reutersGroup({
      entityId: "ent-ap",
      entityCanonicalName: "Associated Press",
      articleIds: ["a3", "a4"],
      observations: [
        observation({
          observationId: "o3",
          articleId: "a3",
          entityId: "ent-ap",
          rawEntityText: "AP",
        }),
        observation({
          observationId: "o4",
          articleId: "a4",
          entityId: "ent-ap",
          rawEntityText: "AP",
        }),
      ],
    });
    const articles = [article("a1"), article("a2"), article("a3"), article("a4")];
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [reutersGroup(), apGroup] }),
      articles,
      true,
    );
    const names = view.reportingSourceGroups.map((g) => g.entityName).sort();
    expect(names).toEqual(["Associated Press", "Reuters"]);
  });
});

describe("C — a government entity is worded safely (referenced_source, not reporting_intermediary)", () => {
  it("marks a GOVERNMENT_AGENCY group as referenced_source", () => {
    const dojGroup = reutersGroup({
      entityId: "ent-doj",
      entityCanonicalName: "U.S. Department of Justice",
      entityType: "GOVERNMENT_AGENCY",
      articleIds: ["a1", "a2"],
    });
    const articles = [article("a1"), article("a2")];
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [dojGroup] }),
      articles,
      true,
    );
    expect(view.reportingSourceGroups[0]?.kind).toBe("referenced_source");
  });
});

describe("D — unresolved articles", () => {
  it("passes unresolvedArticleCount through as sourcingNotDetectedCount", () => {
    const view = buildStoryIntelligenceView(summary({ unresolvedArticleCount: 3 }), [], true);
    expect(view.sourcingNotDetectedCount).toBe(3);
  });
});

describe("E — original-reporting signal", () => {
  it("exposes count for everyone, items only when entitled", () => {
    const s = summary({
      originalReportingSignals: [
        {
          articleId: "a1",
          publisherSourceId: "src-a1",
          publisherName: "Source a1",
          observationId: "o9",
          confidence: "HIGH",
          evidenceText: "the reporter witnessed the events",
        },
      ],
    });
    const articles = [article("a1"), article("a2")];

    const free = buildStoryIntelligenceView(s, articles, false);
    expect(free.originalReporting).toEqual({ count: 1, items: undefined });

    const full = buildStoryIntelligenceView(s, articles, true);
    expect(full.originalReporting?.count).toBe(1);
    expect(full.originalReporting?.items).toHaveLength(1);
    expect(full.originalReporting?.items?.[0]).toMatchObject({
      articleId: "a1",
      evidenceText: "the reporter witnessed the events",
    });
  });
});

describe("F — zero provenance", () => {
  it("returns an empty groups array and null originalReporting", () => {
    const view = buildStoryIntelligenceView(
      summary({
        sharedReportingSourceGroups: [],
        originalReportingSignals: [],
        unresolvedArticleCount: 2,
      }),
      [article("a1"), article("a2")],
      true,
    );
    expect(view.reportingSourceGroups).toEqual([]);
    expect(view.originalReporting).toBeNull();
    expect(view.sourcingNotDetectedCount).toBe(2);
  });
});

describe("G — one article", () => {
  it("articleCount 1 with no groups (backend never produces a group for <2 articles)", () => {
    const view = buildStoryIntelligenceView(
      summary({ articleCount: 1, sharedReportingSourceGroups: [] }),
      [article("a1")],
      true,
    );
    expect(view.articleCount).toBe(1);
    expect(view.reportingSourceGroups).toEqual([]);
  });
});

describe("H — multiple observations in the same article/entity count the article once", () => {
  it("articleCount on the group reflects distinct articleIds, not observation count", () => {
    const group = reutersGroup({
      articleIds: ["a1"], // backend already dedupes to one distinct article
      observations: [
        observation({ observationId: "o1", articleId: "a1", evidenceText: "Reuters reported X" }),
        observation({
          observationId: "o2",
          articleId: "a1",
          evidenceText: "Reuters also reported Y",
        }),
      ],
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1")],
      true,
    );
    expect(view.reportingSourceGroups[0]?.articleCount).toBe(1);
    expect(view.reportingSourceGroups[0]?.articles).toHaveLength(1);
  });
});

describe("I — merged entity displays the canonical entity name", () => {
  it("shows only the backend-resolved canonicalName, never a pre-merge duplicate name", () => {
    // The backend (buildSourceGroups.ts) already resolves mergedIntoId
    // before this DTO exists — the view model just has to not break that.
    const group = reutersGroup({ entityCanonicalName: "U.S. Department of Justice" });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1"), article("a2")],
      true,
    );
    expect(view.reportingSourceGroups[0]?.entityName).toBe("U.S. Department of Justice");
  });
});

describe("J — a stale/legacy-shaped observation with no matching article is skipped, not crashed on", () => {
  it("never throws when an observation references an articleId not in the loaded article list", () => {
    const group = reutersGroup({
      articleIds: ["a1", "a-does-not-exist"],
      observations: [
        observation({ observationId: "o1", articleId: "a1" }),
        observation({ observationId: "o2", articleId: "a-does-not-exist" }),
      ],
    });
    expect(() =>
      buildStoryIntelligenceView(
        summary({ sharedReportingSourceGroups: [group] }),
        [article("a1")],
        true,
      ),
    ).not.toThrow();
  });
});

describe("K — evidence snippet rendering", () => {
  it("carries the evidenceText through unmodified", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], true);
    const evidence = view.reportingSourceGroups[0]?.evidence ?? [];
    expect(evidence.map((e) => e.evidenceText)).toContain("Reuters reported the news.");
  });
});

describe("L — hostile text passes through as plain data (rendering safety is React's job, tested structurally elsewhere)", () => {
  it("does not alter or strip a hostile evidenceText string", () => {
    const hostile = "<script>alert(1)</script><img src=x onerror=alert(1)> & \" '";
    const group = reutersGroup({
      observations: [observation({ observationId: "o1", articleId: "a1", evidenceText: hostile })],
      articleIds: ["a1"],
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1")],
      true,
    );
    expect(view.reportingSourceGroups[0]?.evidence?.[0]?.evidenceText).toBe(hostile);
  });
});

describe("M — long entity/publisher names pass through unmodified (truncation is a CSS/layout concern)", () => {
  it("does not truncate a very long entity name", () => {
    const longName = "A".repeat(300);
    const group = reutersGroup({ entityCanonicalName: longName });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1"), article("a2")],
      true,
    );
    expect(view.reportingSourceGroups[0]?.entityName).toBe(longName);
  });
});

describe("AA — safe view model leaks no internal provenance IDs/metadata", () => {
  it("the full-access view model never contains a forbidden key or the ADMIN_OVERRIDE literal", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], true);
    assertNoForbiddenKeys(view);
  });

  it("the free view model never contains a forbidden key or the ADMIN_OVERRIDE literal", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], false);
    assertNoForbiddenKeys(view);
  });
});

describe("AB — Free/logged-out client payload contains no premium evidence", () => {
  it("omits articles/evidence entirely on every group when not entitled", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], false);
    for (const group of view.reportingSourceGroups) {
      expect(group.articles).toBeUndefined();
      expect(group.evidence).toBeUndefined();
    }
    expect(JSON.stringify(view)).not.toContain("Reuters reported the news.");
  });

  it("truncates the group list to MAX_FREE_REPORTING_GROUPS and reports the true total", () => {
    const groups = ["Reuters", "AP", "DOJ", "FBI"].map((name, i) =>
      reutersGroup({
        entityId: `ent-${i}`,
        entityCanonicalName: name,
        articleIds: [`a${i}a`, `a${i}b`],
        observations: [
          observation({ observationId: `o${i}a`, articleId: `a${i}a` }),
          observation({ observationId: `o${i}b`, articleId: `a${i}b` }),
        ],
      }),
    );
    const articles = groups.flatMap((_, i) => [article(`a${i}a`), article(`a${i}b`)]);
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: groups }),
      articles,
      false,
    );
    expect(view.reportingSourceGroups).toHaveLength(MAX_FREE_REPORTING_GROUPS);
    expect(view.totalReportingSourceGroupCount).toBe(4);
  });
});

describe("AC — article count uses live Phase 8 articleCount", () => {
  it("passes summary.articleCount through directly, not a locally recomputed value", () => {
    const view = buildStoryIntelligenceView(summary({ articleCount: 42 }), [], true);
    expect(view.articleCount).toBe(42);
  });
});

describe("AD — publisher count uses live Phase 8 publisherCount", () => {
  it("passes summary.publisherCount through directly", () => {
    const view = buildStoryIntelligenceView(summary({ publisherCount: 18 }), [], true);
    expect(view.publisherCount).toBe(18);
  });
});

describe("AE — one article with multiple Reuters observations counts once", () => {
  it("group.articleCount is 1, matching the backend's already-deduped articleIds", () => {
    const group = reutersGroup({
      articleIds: ["a1"],
      observations: Array.from({ length: 5 }, (_, i) =>
        observation({ observationId: `o${i}`, articleId: "a1", evidenceText: `snippet ${i}` }),
      ),
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1")],
      true,
    );
    expect(view.reportingSourceGroups[0]?.articleCount).toBe(1);
  });
});

describe("AF — no primary-evidence data is ever produced", () => {
  it("StoryIntelligenceView has no primaryEvidence field at all", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], true);
    expect(Object.keys(view)).not.toContain("primaryEvidence");
    expect(Object.keys(view)).not.toContain("primaryEvidenceGroups");
  });
});

describe("AH — no raw confidence enum is exposed", () => {
  it("evidence items never carry a confidence/HIGH/MEDIUM field", () => {
    const view = buildStoryIntelligenceView(summary(), [article("a1"), article("a2")], true);
    const evidence = view.reportingSourceGroups[0]?.evidence ?? [];
    for (const item of evidence) {
      expect(item).not.toHaveProperty("confidence");
    }
    expect(JSON.stringify(view)).not.toMatch(/"HIGH"|"MEDIUM"/);
  });
});

describe("AJ — max 5 evidence snippets displayed per article", () => {
  it("caps evidence entries at MAX_EVIDENCE_PER_ARTICLE for one article with many observations, prioritizing HIGH", () => {
    const observations: ObservationRef[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        observation({
          observationId: `low${i}`,
          articleId: "a1",
          confidence: "MEDIUM",
          evidenceText: `medium-${i}`,
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        observation({
          observationId: `high${i}`,
          articleId: "a1",
          confidence: "HIGH",
          evidenceText: `high-${i}`,
        }),
      ),
    ];
    const group = reutersGroup({ articleIds: ["a1"], observations });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1")],
      true,
    );
    const evidence = view.reportingSourceGroups[0]?.evidence ?? [];
    expect(evidence).toHaveLength(MAX_EVIDENCE_PER_ARTICLE);
    // All 3 HIGH snippets must be present; only 2 of the 5 MEDIUM ones fit.
    const texts = evidence.map((e) => e.evidenceText);
    expect(texts.filter((t) => t.startsWith("high-"))).toHaveLength(3);
    expect(texts.filter((t) => t.startsWith("medium-"))).toHaveLength(2);
  });

  it("caps evidence independently per distinct article within the same group", () => {
    const observations: ObservationRef[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        observation({ observationId: `a1-${i}`, articleId: "a1", evidenceText: `a1-snip-${i}` }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        observation({ observationId: `a2-${i}`, articleId: "a2", evidenceText: `a2-snip-${i}` }),
      ),
    ];
    const group = reutersGroup({ articleIds: ["a1", "a2"], observations });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [article("a1"), article("a2")],
      true,
    );
    const evidence = view.reportingSourceGroups[0]?.evidence ?? [];
    expect(evidence.filter((e) => e.articleId === "a1")).toHaveLength(MAX_EVIDENCE_PER_ARTICLE);
    expect(evidence.filter((e) => e.articleId === "a2")).toHaveLength(MAX_EVIDENCE_PER_ARTICLE);
  });
});

describe("reporting-source group ordering", () => {
  it("sorts groups by article count descending for display, tie-breaking by name", () => {
    const small = reutersGroup({
      entityId: "ent-small",
      entityCanonicalName: "AP",
      articleIds: ["a1", "a2"],
    });
    const big = reutersGroup({
      entityId: "ent-big",
      entityCanonicalName: "Reuters",
      articleIds: ["a1", "a2", "a3"],
      observations: [
        observation({ observationId: "o1", articleId: "a1" }),
        observation({ observationId: "o2", articleId: "a2" }),
        observation({ observationId: "o3", articleId: "a3" }),
      ],
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [small, big] }),
      [article("a1"), article("a2"), article("a3")],
      true,
    );
    expect(view.reportingSourceGroups.map((g) => g.entityName)).toEqual(["Reuters", "AP"]);
  });
});

describe("determinism", () => {
  it("produces byte-identical output for the same input across repeated calls", () => {
    const s = summary();
    const articles = [article("a1"), article("a2")];
    const v1 = buildStoryIntelligenceView(s, articles, true);
    const v2 = buildStoryIntelligenceView(s, articles, true);
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
  });
});

describe("type shape sanity", () => {
  it("status is always 'ok' from this function (unavailable is only produced by the loader)", () => {
    const view: StoryIntelligenceView = buildStoryIntelligenceView(summary(), [], true);
    expect(view.status).toBe("ok");
  });
});

describe("hostile article URL is never rendered as a clickable link", () => {
  it("strips a javascript: article URL to an empty string in both articles[] and evidence[]", () => {
    const hostileArticle = article("a1", { url: "javascript:alert(document.cookie)" });
    const group = reutersGroup({
      articleIds: ["a1", "a2"],
      observations: [
        observation({ observationId: "o1", articleId: "a1" }),
        observation({ observationId: "o2", articleId: "a2" }),
      ],
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [hostileArticle, article("a2")],
      true,
    );
    const g = view.reportingSourceGroups[0]!;
    const articleLink = g.articles!.find((a) => a.articleId === "a1")!;
    const evidenceLink = g.evidence!.find((e) => e.articleId === "a1")!;
    expect(articleLink.url).toBe("");
    expect(evidenceLink.url).toBe("");
    expect(JSON.stringify(view)).not.toMatch(/javascript:/i);
  });

  it("strips a data: article URL the same way", () => {
    const hostileArticle = article("a1", { url: "data:text/html,<script>alert(1)</script>" });
    const group = reutersGroup({ articleIds: ["a1", "a2"] });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      [hostileArticle, article("a2")],
      true,
    );
    const articleLink = view.reportingSourceGroups[0]!.articles!.find((a) => a.articleId === "a1")!;
    expect(articleLink.url).toBe("");
  });

  it("leaves an ordinary https:// article URL unchanged", () => {
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [reutersGroup()] }),
      [article("a1"), article("a2")],
      true,
    );
    const articleLink = view.reportingSourceGroups[0]!.articles!.find((a) => a.articleId === "a1")!;
    expect(articleLink.url).toBe("https://example.com/a1");
  });

  it("strips a hostile URL in an original-reporting item too", () => {
    const hostileArticle = article("a1", { url: "javascript:alert(1)" });
    const s = summary({
      sharedReportingSourceGroups: [],
      originalReportingSignals: [
        {
          articleId: "a1",
          publisherSourceId: "src-a1",
          publisherName: "Source a1",
          observationId: "o1",
          confidence: "HIGH",
          evidenceText: "the reporter witnessed the events",
        },
      ],
    });
    const view = buildStoryIntelligenceView(s, [hostileArticle], true);
    expect(view.originalReporting?.items?.[0]?.url).toBe("");
  });
});

describe("per-group total evidence cap (MAX_EVIDENCE_ITEMS_PER_GROUP)", () => {
  it("caps the flattened evidence list even when every article contributes the per-article max", () => {
    // 25 articles x 5 evidence each = 125 candidate items, comfortably over
    // MAX_EVIDENCE_ITEMS_PER_GROUP (100) but each individually under
    // MAX_ARTICLES_PER_GROUP_DISPLAY (50) and MAX_EVIDENCE_PER_ARTICLE (5).
    const articleCount = 25;
    const articleIds = Array.from({ length: articleCount }, (_, i) => `a${i}`);
    const articles = articleIds.map((id) => article(id));
    const observations: ObservationRef[] = articleIds.flatMap((id, ai) =>
      Array.from({ length: 5 }, (_, i) =>
        observation({
          observationId: `${id}-o${i}`,
          articleId: id,
          evidenceText: `snip-${ai}-${i}`,
        }),
      ),
    );
    const group = reutersGroup({ articleIds, observations });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      articles,
      true,
    );
    const g = view.reportingSourceGroups[0]!;
    expect(g.articleCount).toBe(articleCount); // true count unaffected
    expect(g.articles).toHaveLength(articleCount); // under the 50-article cap, all displayed
    expect(g.evidence!.length).toBe(MAX_EVIDENCE_ITEMS_PER_GROUP);
  });
});

describe("giant-cluster defense — a single group never renders unbounded articles/evidence", () => {
  it("caps articles/evidence at MAX_ARTICLES_PER_GROUP_DISPLAY while articleCount stays the true total", () => {
    const n = MAX_ARTICLES_PER_GROUP_DISPLAY + 25;
    const articleIds = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, "0")}`);
    const articles = articleIds.map((id) => article(id));
    const group = reutersGroup({
      articleIds,
      observations: articleIds.map((id, i) =>
        observation({ observationId: `o${i}`, articleId: id }),
      ),
    });
    const view = buildStoryIntelligenceView(
      summary({ sharedReportingSourceGroups: [group] }),
      articles,
      true,
    );

    const g = view.reportingSourceGroups[0]!;
    expect(g.articleCount).toBe(n); // the true, untruncated count
    expect(g.articles).toHaveLength(MAX_ARTICLES_PER_GROUP_DISPLAY);
    expect(g.evidence!.length).toBeLessThanOrEqual(
      MAX_ARTICLES_PER_GROUP_DISPLAY * MAX_EVIDENCE_PER_ARTICLE,
    );
  });

  it("caps original-reporting items at MAX_ARTICLES_PER_GROUP_DISPLAY while the count stays the true total", () => {
    const n = MAX_ARTICLES_PER_GROUP_DISPLAY + 10;
    const articleIds = Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, "0")}`);
    const articles = articleIds.map((id) => article(id));
    const s = summary({
      originalReportingSignals: articleIds.map((id, i) => ({
        articleId: id,
        publisherSourceId: `src-${id}`,
        publisherName: `Source ${id}`,
        observationId: `o${i}`,
        confidence: "HIGH" as const,
        evidenceText: "the reporter witnessed the events",
      })),
    });
    const view = buildStoryIntelligenceView(s, articles, true);
    expect(view.originalReporting?.count).toBe(n);
    expect(view.originalReporting?.items).toHaveLength(MAX_ARTICLES_PER_GROUP_DISPLAY);
  });
});
