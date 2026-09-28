import { prisma } from "@/lib/db";
import { getClusterOriginSummary } from "@/lib/graph/getClusterOriginSummary";
import { can } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import {
  buildStoryIntelligenceView,
  type StoryIntelligenceResult,
  type ViewArticle,
} from "@/lib/storyIntelligenceView";
import type { StoryClusterCard } from "@/lib/stories";

/**
 * Resolves the current viewer's id for Story Intelligence's entitlement
 * check, failing safely to anonymous (null) on any error — the exact same
 * fail-to-anonymous precedent resolveViewerAdEligibility already
 * establishes in src/lib/ads.ts. Before this feature, the story page had
 * no dependency on the auth/session tables at all; a transient failure
 * here must degrade to the Free/logged-out experience, never crash the
 * page. Kept separate from loadStoryIntelligence (which stays a plain,
 * explicit-userId function, fully unit-testable with no request scope —
 * the same next/headers-glue split getCurrentUser.ts itself documents).
 */
export async function resolveStoryIntelligenceViewerId(): Promise<string | null> {
  try {
    const user = await getCurrentUser();
    return user?.id ?? null;
  } catch (err) {
    console.error(
      "[storyIntelligence] failed to resolve current user, treating as anonymous:",
      err,
    );
    return null;
  }
}

/**
 * Phase 9B's server-only orchestrator: loads Phase 8's ClusterOriginSummary
 * and the current viewer's entitlement, then maps them through the safe
 * view-model layer. This is the ONLY place Story Intelligence data is
 * loaded — src/app/story/[slug]/page.tsx calls this once and passes the
 * result straight to <StoryIntelligence>.
 *
 * `userId` is an explicit, plain parameter (not read from cookies in here)
 * for the same reason getCurrentUser.ts itself is split into a thin
 * next/headers-reading glue function and a plain, testable resolver: it
 * keeps this function callable from a Vitest test with no request scope,
 * and keeps the "resolve the current viewer" failure mode owned by the
 * caller (see the page component's own defensive wrapper around
 * getCurrentUser(), which — matching resolveViewerAdEligibility's own
 * precedent in src/lib/ads.ts — fails safely to anonymous rather than
 * letting a session-resolution hiccup propagate here).
 *
 * Failure isolation (locked requirement): a failure anywhere in this
 * function — getClusterOriginSummary throwing, the entitlement lookup
 * throwing — must never propagate to the caller and must never take down
 * the rest of the story page. The two failure modes are handled
 * differently on purpose:
 *  - getClusterOriginSummary throwing means there is nothing safe to show
 *    at all, so the whole section resolves to `{ status: "unavailable" }`.
 *  - can() throwing is an entitlement-service hiccup, not a reason to hide
 *    already-available sourcing data — it fails CLOSED to hasFullAccess =
 *    false (the Free/logged-out experience) rather than either granting
 *    full access or taking down the section, matching this codebase's
 *    existing fail-closed-for-paid-features precedent
 *    (resolveViewerAdEligibility in src/lib/ads.ts fails the opposite
 *    direction — no ads — for the same "never risk a paid guarantee on an
 *    error" reason).
 * Neither path ever attaches a stack trace, error message, or other
 * internal detail to the returned shape (see storyIntelligenceView.ts's
 * StoryIntelligenceResult) — only a server-side console.error.
 */
export async function loadStoryIntelligence(
  cluster: StoryClusterCard,
  userId: string | null,
): Promise<StoryIntelligenceResult> {
  let hasFullAccess = false;
  try {
    hasFullAccess = await can(userId, "provenance_full");
  } catch (err) {
    console.error(
      `[storyIntelligence] entitlement lookup failed for cluster ${cluster.id}, defaulting to no full access:`,
      err,
    );
    hasFullAccess = false;
  }

  try {
    const summary = await getClusterOriginSummary(prisma, cluster.id);
    const articles: ViewArticle[] = cluster.articles.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      source: { id: a.source.id, name: a.source.name },
    }));

    return buildStoryIntelligenceView(summary, articles, hasFullAccess);
  } catch (err) {
    console.error(`[storyIntelligence] failed to load for cluster ${cluster.id}:`, err);
    return { status: "unavailable" };
  }
}
