import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getSourceProfile, toPublicSourceProfile } from "@/lib/sourceProfile";
import { GET as getSourceProfileRoute } from "@/app/api/sources/[id]/route";

let categoryId: string;
let legacySourceId: string;
let completeSourceId: string;
let minimalSourceId: string;
let conflictSourceId: string;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-source-profiles", name: "Test Source Profiles", order: 999 },
  });
  categoryId = category.id;

  // A "legacy" row: only the fields that existed before Phase 6, nothing else set.
  const legacy = await prisma.source.create({
    data: {
      name: "Legacy Wire Service",
      url: "https://legacy.example.com/feed.xml",
      categorySlug: "test-source-profiles",
    },
  });
  legacySourceId = legacy.id;

  const complete = await prisma.source.create({
    data: {
      name: "Example Daily",
      url: "https://example-daily.example.com/feed.xml",
      categorySlug: "test-source-profiles",
      homepageUrl: "https://example-daily.example.com",
      logoUrl: "https://example-daily.example.com/logo.png",
      description: "A synthetic test publisher used only for automated tests.",
      sourceType: "newspaper",
      country: "Testland",
      ownership: "Example Media Group (synthetic)",
      foundedYear: 1990,
      profileUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  completeSourceId = complete.id;

  const minimal = await prisma.source.create({
    data: {
      name: "Example Wire",
      url: "https://example-wire.example.com/feed.xml",
      categorySlug: "test-source-profiles",
    },
  });
  minimalSourceId = minimal.id;

  const conflict = await prisma.source.create({
    data: {
      name: "Example Research Institute",
      url: "https://example-research.example.com/feed.xml",
      categorySlug: "test-source-profiles",
    },
  });
  conflictSourceId = conflict.id;

  await prisma.externalAssessment.createMany({
    data: [
      {
        sourceId: completeSourceId,
        provider: "Example Rating Institute (synthetic)",
        assessmentType: "factuality",
        ratingValue: "High",
        retrievedAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        sourceId: conflictSourceId,
        provider: "Example Rating Institute (synthetic)",
        assessmentType: "political_lean",
        ratingValue: "Lean left",
        referenceUrl: "https://rating-institute.example.com/example-research",
        assessedAt: new Date("2025-06-01T00:00:00Z"),
      },
      {
        sourceId: conflictSourceId,
        provider: "Sample Media Observatory (synthetic)",
        assessmentType: "political_lean",
        ratingValue: "Lean right",
        referenceUrl: "https://media-observatory.example.com/example-research",
        assessedAt: new Date("2025-07-01T00:00:00Z"),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.externalAssessment.deleteMany({
    where: {
      sourceId: { in: [legacySourceId, completeSourceId, minimalSourceId, conflictSourceId] },
    },
  });
  await prisma.source.deleteMany({
    where: { id: { in: [legacySourceId, completeSourceId, minimalSourceId, conflictSourceId] } },
  });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

describe("legacy Source rows remain valid", () => {
  it("a pre-Phase-6 row (no profile fields ever set) loads fine with all new fields null", async () => {
    const profile = await getSourceProfile(legacySourceId);
    expect(profile).not.toBeNull();
    expect(profile!.description).toBeNull();
    expect(profile!.sourceType).toBeNull();
    expect(profile!.country).toBeNull();
    expect(profile!.ownership).toBeNull();
    expect(profile!.foundedYear).toBeNull();
    expect(profile!.profileUpdatedAt).toBeNull();
    expect(profile!.externalAssessments).toEqual([]);
  });
});

describe("source profile completeness", () => {
  it("a fully-populated profile returns every field", async () => {
    const profile = await getSourceProfile(completeSourceId);
    expect(profile).not.toBeNull();
    const pub = toPublicSourceProfile(profile!);
    expect(pub.description).toContain("synthetic test publisher");
    expect(pub.sourceType).toBe("newspaper");
    expect(pub.country).toBe("Testland");
    expect(pub.ownership).toContain("Example Media Group");
    expect(pub.foundedYear).toBe(1990);
    expect(pub.profileUpdatedAt).not.toBeNull();
  });

  it("a minimal profile (nothing but name/url/category) still serializes cleanly with nulls, not errors", async () => {
    const profile = await getSourceProfile(minimalSourceId);
    const pub = toPublicSourceProfile(profile!);
    expect(pub.name).toBe("Example Wire");
    expect(pub.description).toBeNull();
    expect(pub.sourceType).toBeNull();
    expect(pub.assessments).toEqual([]);
  });

  it("unknown/missing metadata is represented as null, never invented or defaulted to a non-null placeholder", async () => {
    const profile = await getSourceProfile(minimalSourceId);
    const pub = toPublicSourceProfile(profile!);
    expect(pub.ownership).toBeNull();
    expect(pub.foundedYear).toBeNull();
    expect(pub.homepageUrl).toBeNull();
    expect(pub.logoUrl).toBeNull();
  });
});

describe("external assessments: multiple providers and disagreement", () => {
  it("a source can carry assessments from multiple distinct providers", async () => {
    const profile = await getSourceProfile(conflictSourceId);
    const pub = toPublicSourceProfile(profile!);
    const providers = new Set(pub.assessments.map((a) => a.provider));
    expect(providers.size).toBe(2);
    expect(providers.has("Example Rating Institute (synthetic)")).toBe(true);
    expect(providers.has("Sample Media Observatory (synthetic)")).toBe(true);
  });

  it("conflicting political-lean assessments are BOTH preserved verbatim, never averaged or merged into one value", async () => {
    const profile = await getSourceProfile(conflictSourceId);
    const pub = toPublicSourceProfile(profile!);
    const leanRatings = pub.assessments
      .filter((a) => a.assessmentType === "political_lean")
      .map((a) => a.ratingValue)
      .sort();
    expect(leanRatings).toEqual(["Lean left", "Lean right"]);
  });

  it("every assessment always carries its provider attribution — never anonymous", async () => {
    const profile = await getSourceProfile(conflictSourceId);
    const pub = toPublicSourceProfile(profile!);
    for (const assessment of pub.assessments) {
      expect(assessment.provider).toBeTruthy();
      expect(assessment.provider.length).toBeGreaterThan(0);
    }
  });

  it("the public shape contains no synthesized/derived score field — no 'veriquenScore', 'biasScore', or similar", async () => {
    const profile = await getSourceProfile(conflictSourceId);
    const pub = toPublicSourceProfile(profile!);
    const keys = Object.keys(pub);
    expect(keys.some((k) => /score/i.test(k))).toBe(false);
    for (const assessment of pub.assessments) {
      expect(Object.keys(assessment).some((k) => /score/i.test(k))).toBe(false);
    }
  });
});

describe("external assessments: same provider, multiple types and multiple dates (history)", () => {
  it("the same provider can rate the same source on more than one assessment type", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Multi-Type Source",
        url: "https://example-multitype.example.com/feed.xml",
        categorySlug: "test-source-profiles",
      },
    });
    await prisma.externalAssessment.createMany({
      data: [
        {
          sourceId: source.id,
          provider: "Example Rating Institute (synthetic)",
          assessmentType: "credibility",
          ratingValue: "High",
        },
        {
          sourceId: source.id,
          provider: "Example Rating Institute (synthetic)",
          assessmentType: "reliability",
          ratingValue: "Mixed",
        },
      ],
    });
    const profile = await getSourceProfile(source.id);
    const pub = toPublicSourceProfile(profile!);
    expect(pub.assessments).toHaveLength(2);
    const types = pub.assessments.map((a) => a.assessmentType).sort();
    expect(types).toEqual(["credibility", "reliability"]);

    await prisma.externalAssessment.deleteMany({ where: { sourceId: source.id } });
    await prisma.source.delete({ where: { id: source.id } });
  });

  it("the same provider/type pair can be recorded more than once over time (no uniqueness constraint blocks history)", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example History Source",
        url: "https://example-history.example.com/feed.xml",
        categorySlug: "test-source-profiles",
      },
    });
    await prisma.externalAssessment.createMany({
      data: [
        {
          sourceId: source.id,
          provider: "Example Rating Institute (synthetic)",
          assessmentType: "political_lean",
          ratingValue: "Center",
          assessedAt: new Date("2023-01-01T00:00:00Z"),
        },
        {
          sourceId: source.id,
          provider: "Example Rating Institute (synthetic)",
          assessmentType: "political_lean",
          ratingValue: "Lean left",
          assessedAt: new Date("2025-01-01T00:00:00Z"),
        },
      ],
    });
    const profile = await getSourceProfile(source.id);
    const pub = toPublicSourceProfile(profile!);
    // Both historical ratings from the same provider survive as distinct
    // rows — an updated rating never overwrites/replaces the older one.
    expect(pub.assessments).toHaveLength(2);
    expect(pub.assessments.map((a) => a.ratingValue).sort()).toEqual(["Center", "Lean left"]);

    await prisma.externalAssessment.deleteMany({ where: { sourceId: source.id } });
    await prisma.source.delete({ where: { id: source.id } });
  });

  it("deleting a Source cascades to delete its ExternalAssessment rows (no orphans left behind)", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Cascade-Delete Source",
        url: "https://example-cascade.example.com/feed.xml",
        categorySlug: "test-source-profiles",
      },
    });
    const assessment = await prisma.externalAssessment.create({
      data: {
        sourceId: source.id,
        provider: "Example Rating Institute (synthetic)",
        assessmentType: "credibility",
        ratingValue: "High",
      },
    });

    await prisma.source.delete({ where: { id: source.id } });

    const orphan = await prisma.externalAssessment.findUnique({ where: { id: assessment.id } });
    expect(orphan).toBeNull();
  });
});

describe("public /api/sources/[id] route", () => {
  it("returns the full public profile shape for a known id", async () => {
    const res = await getSourceProfileRoute(new Request("http://localhost/api/sources/x"), {
      params: Promise.resolve({ id: completeSourceId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(completeSourceId);
    expect(body.name).toBe("Example Daily");
    expect(body.sourceType).toBe("newspaper");
    expect(Array.isArray(body.assessments)).toBe(true);
  });

  it("404s for an unknown id", async () => {
    const res = await getSourceProfileRoute(new Request("http://localhost/api/sources/x"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("never exposes admin/internal-only fields (feed url, ingestion health)", async () => {
    const res = await getSourceProfileRoute(new Request("http://localhost/api/sources/x"), {
      params: Promise.resolve({ id: completeSourceId }),
    });
    const body = await res.json();
    expect(body.url).toBeUndefined();
    expect(body.active).toBeUndefined();
    expect(body.fetchIntervalMinutes).toBeUndefined();
    expect(body.lastFetchedAt).toBeUndefined();
    expect(body.lastError).toBeUndefined();
    expect(body.consecutiveFailures).toBeUndefined();
  });
});

describe("toPublicSourceProfile never leaks internal/admin-only fields, even when they're populated", () => {
  it("a source with every internal field deliberately set to a sentinel value produces a public profile containing none of those sentinels", async () => {
    const SENTINEL = "SENTINEL-INTERNAL-VALUE-SHOULD-NEVER-LEAK";
    const source = await prisma.source.create({
      data: {
        name: "Example Sentinel Source",
        url: `https://${SENTINEL}-feed.example.com/rss?token=${SENTINEL}`,
        categorySlug: "test-source-profiles",
        active: false,
        fetchIntervalMinutes: 999,
        lastError: `Fetch failed: ${SENTINEL} internal stack trace at /srv/app/worker.js:42`,
        consecutiveFailures: 7,
        lastFetchedAt: new Date("2020-01-01T00:00:00Z"),
        lastSuccessAt: new Date("2020-01-01T00:00:00Z"),
        lastErrorAt: new Date("2020-01-01T00:00:00Z"),
        description: "A normal public description, unrelated to the sentinel.",
      },
    });

    const profile = await getSourceProfile(source.id);
    const pub = toPublicSourceProfile(profile!);
    const serialized = JSON.stringify(pub);

    // Content check: the sentinel string never appears anywhere in the
    // public payload, not even nested inside an unexpected field.
    expect(serialized).not.toContain(SENTINEL);

    // Shape check: only the documented public fields are present — a
    // future accidental `{ ...source }` spread would add keys this list
    // doesn't expect and this assertion would catch it.
    expect(Object.keys(pub).sort()).toEqual(
      [
        "id",
        "name",
        "homepageUrl",
        "logoUrl",
        "categorySlug",
        "description",
        "sourceType",
        "country",
        "ownership",
        "foundedYear",
        "profileUpdatedAt",
        "assessments",
      ].sort(),
    );

    await prisma.source.delete({ where: { id: source.id } });
  });
});

describe("ingestion regression: routine fetch updates must not clobber profile fields", () => {
  it("a partial update touching only ingestion-health fields leaves profile fields untouched", async () => {
    await prisma.source.update({
      where: { id: completeSourceId },
      data: { lastFetchedAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0 },
    });
    const profile = await getSourceProfile(completeSourceId);
    expect(profile!.description).toContain("synthetic test publisher");
    expect(profile!.sourceType).toBe("newspaper");
    expect(profile!.profileUpdatedAt).not.toBeNull();
  });
});
