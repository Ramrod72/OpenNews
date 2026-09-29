import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { generateAiStoryBrief, FEATURE_KEY } from "@/lib/ai/storyBrief/generate";
import { getAiConfig } from "@/lib/ai/config";
import { aiSettingsSchema } from "@/lib/validation/settings";
import { createFixedMockProvider } from "@/lib/ai/testing/mockProvider";
import { buildAiStoryBriefInput } from "@/lib/ai/storyBrief/input";
import { fingerprintAiStoryBriefInput } from "@/lib/ai/storyBrief/fingerprint";
import { PROMPT_VERSION } from "@/lib/ai/storyBrief/prompt";
import type { CoverageComparisonView } from "@/lib/coverageComparisonView";
import type { StoryIntelligenceView } from "@/lib/storyIntelligenceView";
import { can, checkUsage } from "@/lib/entitlements";

let categoryId: string;
let clusterCounter = 0;
const disposableUserIds: string[] = [];

beforeAll(async () => {
  await seedPlans(prisma);
  const category = await prisma.category.create({
    data: { slug: "test-ai-kill-switch", name: "Test AI Kill Switch", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.aiStoryBrief.deleteMany({ where: { storyCluster: { categoryId } } });
  await prisma.storyCluster.deleteMany({ where: { categoryId } });
  await prisma.usageRecord.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: disposableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: disposableUserIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.adminSetting.deleteMany({ where: { key: "ai" } });
});

afterEach(async () => {
  await prisma.adminSetting.deleteMany({ where: { key: "ai" } });
});

async function setAiSetting(
  value: Partial<{ provider: string; baseUrl: string; model: string; storyBriefEnabled: boolean }>,
) {
  await prisma.adminSetting.upsert({
    where: { key: "ai" },
    create: { key: "ai", value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
}

async function makeProUser(): Promise<string> {
  clusterCounter += 1;
  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { slug: "pro" } });
  const user = await prisma.user.create({
    data: {
      email: `kill-switch-pro-${clusterCounter}-${Date.now()}@example.com`,
      passwordHash: "x",
    },
  });
  await prisma.subscription.create({
    data: { userId: user.id, planId: proPlan.id, status: "active" },
  });
  disposableUserIds.push(user.id);
  return user.id;
}

async function makeCluster(): Promise<string> {
  clusterCounter += 1;
  const cluster = await prisma.storyCluster.create({
    data: {
      headline: `Kill switch cluster ${clusterCounter}`,
      slug: `test-kill-switch-${clusterCounter}-${Date.now()}`,
      categoryId,
      firstSeenAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  });
  return cluster.id;
}

function coverageWithOneClaimGroup(): CoverageComparisonView {
  return {
    status: "ok",
    hasFullAccess: true,
    hasClaimComparison: true,
    articleCount: 3,
    publisherCount: 3,
    claimGroups: [
      {
        key: "k1",
        kind: "NUMERICAL_ASSERTION",
        text: "12 people were injured",
        articleCount: 3,
        publisherCount: 3,
        numericUnit: "INJURIES",
        numericValue: 12,
        numericQualifier: "EXACT",
        sourceOverlap: [{ entityName: "Reuters", overlapArticleCount: 2 }],
      },
    ],
    totalClaimGroupCount: 1,
    headlineComparison: null,
    limitationsNote: "Comparisons are based on the article text available to Veriqen.",
  };
}
const noIntelligence: StoryIntelligenceView = {
  status: "ok",
  articleCount: 3,
  publisherCount: 3,
  hasFullAccess: true,
  reportingSourceGroups: [],
  totalReportingSourceGroupCount: 0,
  originalReporting: null,
  sourcingNotDetectedCount: 1,
};
function validModelResponse(refs: string[]) {
  return JSON.stringify({
    summary: { text: "Multiple articles report a similar figure.", refs },
    commonAssertions: [{ text: "12 people were injured.", refs }],
    coverageDifferences: [],
    sourceOverlapNotes: [],
    unresolvedQuestions: [],
  });
}

describe("26: backwards compatibility with rows lacking storyBriefEnabled", () => {
  it("a legacy 'ai' row written before this field existed remains valid and falls back to the env-derived default", async () => {
    await setAiSetting({ provider: "none", baseUrl: "http://localhost:11434", model: "llama3.1" });
    delete process.env.AI_STORY_BRIEF_ENABLED;
    const config = await getAiConfig();
    expect(config.storyBriefEnabled).toBe(false); // env default, never throws on the missing key
  });

  it("aiSettingsSchema.partial() accepts a legacy object with no storyBriefEnabled key at all", () => {
    const parsed = aiSettingsSchema
      .partial()
      .safeParse({ provider: "ollama", baseUrl: "x", model: "y" });
    expect(parsed.success).toBe(true);
  });
});

describe("27/28: the toggle persists both ways", () => {
  it("27: enabled persists and is read back as enabled", async () => {
    await setAiSetting({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      storyBriefEnabled: true,
    });
    const config = await getAiConfig();
    expect(config.storyBriefEnabled).toBe(true);
  });

  it("28: disabled persists and is read back as disabled, taking precedence over an enabling env var", async () => {
    process.env.AI_STORY_BRIEF_ENABLED = "true";
    await setAiSetting({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      storyBriefEnabled: false,
    });
    const config = await getAiConfig();
    expect(config.storyBriefEnabled).toBe(false);
    delete process.env.AI_STORY_BRIEF_ENABLED;
  });
});

describe("29/30: validation", () => {
  it("29: a non-boolean storyBriefEnabled is rejected", () => {
    const parsed = aiSettingsSchema.partial().safeParse({ storyBriefEnabled: "yes" });
    expect(parsed.success).toBe(false);
  });

  it("30: an unknown key cannot be smuggled in alongside storyBriefEnabled", () => {
    const parsed = aiSettingsSchema
      .partial()
      .safeParse({ storyBriefEnabled: true, arbitraryKey: "danger" });
    expect(parsed.success).toBe(true); // zod strips unknown keys by default
    expect(parsed.data).not.toHaveProperty("arbitraryKey");
  });

  it("storyBriefTimeoutMs is not part of the admin-editable schema at all", () => {
    const parsed = aiSettingsSchema.partial().safeParse({ storyBriefTimeoutMs: 99999 });
    expect(parsed.data).not.toHaveProperty("storyBriefTimeoutMs");
  });
});

describe("31: disabled state prevents generation AND hides any pre-existing cached artifact — a full kill switch, not just a generation pause", () => {
  it("returns 'disabled' for an entitled Pro user when storyBriefEnabled=false, never reaching the provider", async () => {
    await setAiSetting({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      storyBriefEnabled: false,
    });
    const storyClusterId = await makeCluster();
    const userId = await makeProUser();
    const result = await generateAiStoryBrief(prisma, {
      storyClusterId,
      headline: "h",
      coverage: coverageWithOneClaimGroup(),
      intelligence: noIntelligence,
      userId,
      // No providerOverride — this is the REAL (non-test-injected) path,
      // which is exactly what proves the kill switch, not the test
      // fixture, is what's blocking generation.
    });
    expect(result).toEqual({ status: "disabled" });
  });

  it("a cached artifact matching the exact real-path cache key is still hidden while disabled", async () => {
    const config = await getAiConfig(); // real (disabled-by-default-in-tests) config baseline
    const storyClusterId = await makeCluster();
    const userId = await makeProUser();

    // Populate the cache exactly as a REAL prior generation (while
    // enabled) would have, using providerOverride only to avoid a real
    // network call — providerOverride is a test-only injection point
    // (see generate.ts's own doc comment) and does not change what gets
    // cached.
    const input = buildAiStoryBriefInput({
      headline: "h",
      coverage: coverageWithOneClaimGroup(),
      intelligence: noIntelligence,
    });
    const fingerprint = fingerprintAiStoryBriefInput(input);
    await prisma.aiStoryBrief.create({
      data: {
        storyClusterId,
        feature: FEATURE_KEY,
        inputFingerprint: fingerprint,
        promptVersion: PROMPT_VERSION,
        provider: "ollama",
        model: config.model,
        outputJson: validModelResponse(["CLAIM-GROUP-1"]),
      },
    });

    await setAiSetting({
      provider: "ollama",
      baseUrl: config.baseUrl,
      model: config.model,
      storyBriefEnabled: false,
    });
    const result = await generateAiStoryBrief(prisma, {
      storyClusterId,
      headline: "h",
      coverage: coverageWithOneClaimGroup(),
      intelligence: noIntelligence,
      userId,
    });
    // Disabled short-circuits BEFORE the cache lookup — the pre-existing
    // artifact is never returned while the switch is off.
    expect(result).toEqual({ status: "disabled" });
  });
});

describe("32/33: the toggle changes nothing about entitlement or quota semantics", () => {
  it("32: toggling storyBriefEnabled off/on never changes cross_source_synthesis entitlement for any plan", async () => {
    const proUserId = await makeProUser();
    await setAiSetting({ storyBriefEnabled: true });
    const withEnabled = await can(proUserId, "cross_source_synthesis");
    await setAiSetting({ storyBriefEnabled: false });
    const withDisabled = await can(proUserId, "cross_source_synthesis");
    expect(withEnabled).toBe(true);
    expect(withDisabled).toBe(true); // entitlement is plan-derived, untouched by this operational switch
  });

  it("33: toggling storyBriefEnabled never alters ai_monthly_quota usage state", async () => {
    const proUserId = await makeProUser();
    await setAiSetting({ storyBriefEnabled: true });
    const before = await checkUsage(proUserId, "ai_monthly_quota");
    await setAiSetting({ storyBriefEnabled: false });
    const after = await checkUsage(proUserId, "ai_monthly_quota");
    expect(after.used).toBe(before.used);
    expect(after.limit).toBe(before.limit);
  });
});

describe("34: provider/model behavior is unaffected by this change", () => {
  it("provider/baseUrl/model still round-trip through getAiConfig exactly as before", async () => {
    await setAiSetting({
      provider: "ollama",
      baseUrl: "http://custom-host:11434",
      model: "custom-model",
      storyBriefEnabled: true,
    });
    const config = await getAiConfig();
    expect(config.provider).toBe("ollama");
    expect(config.baseUrl).toBe("http://custom-host:11434");
    expect(config.model).toBe("custom-model");
  });

  it("a real generation call with providerOverride (enabled) still behaves exactly as pre-Phase-13B", async () => {
    await setAiSetting({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      storyBriefEnabled: true,
    });
    const storyClusterId = await makeCluster();
    const userId = await makeProUser();
    const provider = createFixedMockProvider({
      ok: true,
      raw: validModelResponse(["CLAIM-GROUP-1"]),
    });
    const result = await generateAiStoryBrief(prisma, {
      storyClusterId,
      headline: "h",
      coverage: coverageWithOneClaimGroup(),
      intelligence: noIntelligence,
      userId,
      providerOverride: provider,
    });
    expect(result.status).toBe("ok");
    expect(provider.calls).toHaveLength(1);
  });
});
