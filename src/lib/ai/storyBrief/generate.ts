import type { PrismaClient } from "@prisma/client";
import { can, reserveUsage, releaseUsage } from "@/lib/entitlements";
import { getAiConfig } from "@/lib/ai/config";
import { createOllamaProvider } from "./ollamaProvider";
import type { AIProvider } from "@/lib/ai/provider";
import {
  buildAiStoryBriefInput,
  collectValidReferences,
  isInputTooSparse,
  type AiStoryBriefInput,
} from "./input";
import { fingerprintAiStoryBriefInput } from "./fingerprint";
import { buildDataPayload, buildSystemInstructions, PROMPT_VERSION } from "./prompt";
import {
  appendServerLimitations,
  MAX_TOTAL_OUTPUT_CHARS,
  totalOutputChars,
  validateAiStoryBriefOutput,
  type AiStoryBriefOutput,
} from "./schema";
import { withSingleFlight } from "./singleFlight";
import { isRateLimited } from "@/lib/rateLimit";
import type { CoverageComparisonView } from "@/lib/coverageComparisonView";
import type { StoryIntelligenceView } from "@/lib/storyIntelligenceView";

export const FEATURE_KEY = "ai_story_brief";
const ENTITLEMENT_KEY = "cross_source_synthesis";
const QUOTA_KEY = "ai_monthly_quota";
const RATE_LIMIT_PER_MINUTE = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

export type AiStoryBriefResult =
  | { status: "ok"; output: AiStoryBriefOutput; fromCache: boolean }
  | { status: "not_entitled" }
  | { status: "disabled" }
  | { status: "insufficient_data" }
  | { status: "quota_exceeded"; used: number; limit: number }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/**
 * Phase 11B's orchestrator — the ONE place that ties entitlement, quota,
 * caching, the provider call, and output validation together for one
 * StoryCluster + viewer. Mirrors src/lib/coverageComparison.ts's own
 * "single orchestrator, independent failure isolation per concern"
 * pattern exactly.
 *
 * Every early-return path before "reserve quota" costs the caller
 * nothing: entitlement failure, disabled feature, insufficient input, a
 * cache hit, and rate-limiting all resolve without ever touching quota or
 * calling a provider (see this function's own step-by-step comments).
 */
export async function generateAiStoryBrief(
  prisma: PrismaClient,
  params: {
    storyClusterId: string;
    headline: string;
    coverage: CoverageComparisonView;
    intelligence: StoryIntelligenceView | null;
    userId: string | null;
    /** Test-only injection point — production callers never pass this, so the real Ollama provider (built from admin/env config) is always used outside tests. */
    providerOverride?: AIProvider;
  },
): Promise<AiStoryBriefResult> {
  const { storyClusterId, headline, coverage, intelligence, userId } = params;

  // Entitlement check has its OWN try/catch, independent of everything
  // else below — an entitlement-service hiccup fails CLOSED to
  // "not_entitled", exactly Phase 9/10's own precedent, never granting
  // access on error.
  let entitled = false;
  try {
    entitled = userId !== null && (await can(userId, ENTITLEMENT_KEY));
  } catch (err) {
    console.error(`[ai-story-brief] entitlement lookup failed for cluster ${storyClusterId}:`, err);
    entitled = false;
  }
  if (!entitled) return { status: "not_entitled" };

  let config;
  try {
    config = await getAiConfig();
  } catch (err) {
    console.error(`[ai-story-brief] config lookup failed for cluster ${storyClusterId}:`, err);
    return { status: "disabled" };
  }
  // The config-based kill switch only governs the real Ollama provider
  // path. `providerOverride` exists solely for deterministic tests (see
  // this param's own doc comment) — a test supplying it is explicitly
  // exercising the generation path and doesn't need to also manage
  // AdminSetting/env state, but the "disabled" status itself is still
  // independently tested against the real (no-override) config path.
  if (!params.providerOverride && (!config.storyBriefEnabled || config.provider === "none")) {
    return { status: "disabled" };
  }

  const input = buildAiStoryBriefInput({ headline, coverage, intelligence });
  if (isInputTooSparse(input)) {
    return { status: "insufficient_data" };
  }

  const fingerprint = fingerprintAiStoryBriefInput(input);
  const provider =
    params.providerOverride ??
    createOllamaProvider({ baseUrl: config.baseUrl, model: config.model });

  // Cache lookup — never touches quota, never calls the provider.
  try {
    const cached = await prisma.aiStoryBrief.findUnique({
      where: {
        storyClusterId_feature_inputFingerprint_promptVersion_provider_model: {
          storyClusterId,
          feature: FEATURE_KEY,
          inputFingerprint: fingerprint,
          promptVersion: PROMPT_VERSION,
          provider: provider.name,
          model: provider.model,
        },
      },
    });
    if (cached) {
      return {
        status: "ok",
        output: JSON.parse(cached.outputJson) as AiStoryBriefOutput,
        fromCache: true,
      };
    }
  } catch (err) {
    console.error(`[ai-story-brief] cache lookup failed for cluster ${storyClusterId}:`, err);
    // Fall through and attempt a fresh generation rather than failing closed on a read error.
  }

  if (!userId) return { status: "not_entitled" };

  if (isRateLimited(`ai-story-brief:${userId}`, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS)) {
    return { status: "rate_limited" };
  }

  const singleFlightKey = `${userId}:${storyClusterId}:${fingerprint}`;
  return withSingleFlight(singleFlightKey, () =>
    reserveAndGenerate(prisma, { storyClusterId, userId, input, fingerprint, provider }),
  );
}

async function reserveAndGenerate(
  prisma: PrismaClient,
  params: {
    storyClusterId: string;
    userId: string;
    input: AiStoryBriefInput;
    fingerprint: string;
    provider: AIProvider;
  },
): Promise<AiStoryBriefResult> {
  const { storyClusterId, userId, input, fingerprint, provider } = params;
  // Tracks whether reserveUsage itself actually committed an increment —
  // the outer catch below must only ever release a unit that was truly
  // reserved. A second real defect found in the same review: reserveUsage
  // throwing (rather than returning) leaves no committed increment to
  // refund; releasing anyway would incorrectly decrement an unrelated,
  // previously-committed reservation from an earlier, unconnected call.
  let didReserve = false;

  // The reservation call is now INSIDE this same try/catch — a prior
  // version left it outside, so a genuine transaction-timeout exception
  // under heavy SQLite contention (see this function's own concurrency
  // guarantee, and reserveUsage's doc comment in entitlements.ts) would
  // propagate uncaught out of this entire orchestrator, relying entirely
  // on the CALLER (src/lib/aiStoryBrief.ts's own try/catch) to fail
  // closed. Found during the final adversarial review: this function
  // must be self-contained, not merely "safe because whoever calls it
  // happens to also wrap it."
  try {
    const reservation = await reserveUsage(userId, QUOTA_KEY);
    if (!reservation.reserved) {
      return { status: "quota_exceeded", used: reservation.used, limit: reservation.limit ?? 0 };
    }
    didReserve = true;

    const validRefs = collectValidReferences(input);
    const systemInstructions = buildSystemInstructions([...validRefs]);
    const data = buildDataPayload(input);
    const config = await getAiConfig();

    const attempt = async () => {
      const response = await provider.generateStructured({
        systemInstructions,
        data,
        maxOutputChars: 4000,
        timeoutMs: config.storyBriefTimeoutMs,
      });
      if (!response.ok) return { validation: null, providerFailure: response.reason } as const;
      return {
        validation: validateAiStoryBriefOutput(response.raw, validRefs),
        providerFailure: null,
      } as const;
    };

    let result = await attempt();
    if (result.providerFailure) {
      // didReserve is cleared BEFORE the release call itself (not after):
      // if this specific releaseUsage call throws, the outer catch must
      // not attempt a second release for the same reservation — the
      // atomic transaction either fully committed the decrement or not
      // at all, so retrying here risks a double-refund, not a recovery.
      didReserve = false;
      await releaseUsage(userId, QUOTA_KEY);
      return { status: "unavailable" };
    }
    if (!result.validation!.ok) {
      // At most one regeneration attempt after malformed/invalid output, then fail closed.
      result = await attempt();
    }
    if (result.providerFailure || !result.validation!.ok) {
      didReserve = false;
      await releaseUsage(userId, QUOTA_KEY);
      return { status: "unavailable" };
    }

    const output = appendServerLimitations(result.validation!.output, input.limitationsNote);
    if (totalOutputChars(output) > MAX_TOTAL_OUTPUT_CHARS) {
      didReserve = false;
      await releaseUsage(userId, QUOTA_KEY);
      return { status: "unavailable" };
    }

    try {
      await prisma.aiStoryBrief.upsert({
        where: {
          storyClusterId_feature_inputFingerprint_promptVersion_provider_model: {
            storyClusterId,
            feature: FEATURE_KEY,
            inputFingerprint: fingerprint,
            promptVersion: PROMPT_VERSION,
            provider: provider.name,
            model: provider.model,
          },
        },
        create: {
          storyClusterId,
          feature: FEATURE_KEY,
          inputFingerprint: fingerprint,
          promptVersion: PROMPT_VERSION,
          provider: provider.name,
          model: provider.model,
          outputJson: JSON.stringify(output),
        },
        update: {},
      });
    } catch (err) {
      console.error(
        `[ai-story-brief] failed to persist artifact for cluster ${storyClusterId}:`,
        err,
      );
      // The generation itself succeeded and passed validation; a persistence
      // failure shouldn't also fail the response the user is waiting on.
    }

    return { status: "ok", output, fromCache: false };
  } catch (err) {
    console.error(`[ai-story-brief] generation failed for cluster ${storyClusterId}:`, err);
    if (didReserve) {
      try {
        await releaseUsage(userId, QUOTA_KEY);
      } catch (releaseErr) {
        console.error(
          `[ai-story-brief] failed to release quota reservation for cluster ${storyClusterId}:`,
          releaseErr,
        );
      }
    }
    return { status: "unavailable" };
  }
}
