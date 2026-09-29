import { prisma } from "@/lib/db";
import type { StoryClusterCard } from "@/lib/stories";
import { generateAiStoryBrief, type AiStoryBriefResult } from "@/lib/ai/storyBrief/generate";
import type { CoverageComparisonResult } from "@/lib/coverageComparisonView";
import type { StoryIntelligenceResult } from "@/lib/storyIntelligenceView";

/**
 * Phase 11B's server-only entry point, called once per story-page render
 * — mirrors src/lib/coverageComparison.ts's own top-level shape exactly.
 * Builds its AI input EXCLUSIVELY from the two already-computed,
 * already-safe results this same page render also uses for the "Trace
 * this story" and "Common assertions" sections — it never re-queries
 * Claim/ProvenanceObservation independently (see storyBrief/input.ts's
 * own doc comment for why that matters).
 *
 * Isolated in its own try/catch: any unexpected failure here resolves to
 * `{status: "unavailable"}` rather than throwing, so a bug in the AI
 * layer can never take down the rest of the story page (see
 * src/app/story/[slug]/page.tsx's own independent Promise.all handling).
 */
export async function loadAiStoryBrief(
  cluster: StoryClusterCard,
  userId: string | null,
  coverage: CoverageComparisonResult,
  intelligence: StoryIntelligenceResult,
): Promise<AiStoryBriefResult> {
  try {
    if (coverage.status !== "ok") return { status: "unavailable" };
    return await generateAiStoryBrief(prisma, {
      storyClusterId: cluster.id,
      headline: cluster.headline,
      coverage,
      intelligence: intelligence.status === "ok" ? intelligence : null,
      userId,
    });
  } catch (err) {
    console.error(`[ai-story-brief] loadAiStoryBrief failed for cluster ${cluster.id}:`, err);
    return { status: "unavailable" };
  }
}
