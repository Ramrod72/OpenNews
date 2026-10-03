import { prisma } from "@/lib/db";
import type { ExternalAssessment, Source } from "@prisma/client";

export type SourceWithAssessments = Source & { externalAssessments: ExternalAssessment[] };

/**
 * A source's full profile plus every external assessment on file, for the
 * public profile page/API and the admin editor. Returns null for an
 * unknown id — not for a merely-paused (`active: false`) source, since a
 * paused feed's profile (and any story that already links to it) should
 * keep working; "paused" only affects ingestion, not public visibility.
 *
 * Single query, no N+1: the one-to-many `externalAssessments` relation is
 * fetched via `include` in the same round trip.
 */
export async function getSourceProfile(id: string): Promise<SourceWithAssessments | null> {
  return prisma.source.findUnique({
    where: { id },
    include: { externalAssessments: { orderBy: [{ assessmentType: "asc" }, { provider: "asc" }] } },
  });
}

export interface PublicAssessment {
  id: string;
  provider: string;
  assessmentType: string;
  ratingValue: string;
  ratingScale: string | null;
  referenceUrl: string | null;
  assessedAt: string | null;
  retrievedAt: string;
  notes: string | null;
}

export interface PublicSourceProfile {
  id: string;
  name: string;
  homepageUrl: string | null;
  logoUrl: string | null;
  categorySlug: string;
  description: string | null;
  sourceType: string | null;
  country: string | null;
  ownership: string | null;
  foundedYear: number | null;
  profileUpdatedAt: string | null;
  assessments: PublicAssessment[];
}

/**
 * Explicit allowlist for anything this app sends to a browser or the
 * admin-only fields never leak (feed URL, ingestion health, failure
 * counts) — the same "serialize, don't pass the raw Prisma row" pattern
 * used for stories (src/lib/serialize.ts).
 */
/**
 * Deterministic, auditable bar for whether a source profile has enough
 * genuine admin-entered content to be worth indexing publicly — separate
 * from whether it's *accessible*, which every profile always is regardless
 * of this result. A freshly-registered feed only ever has a name/URL/
 * category (set at ingestion time, never by an admin reviewing the
 * profile) — none of that is "content" in the sense a search result
 * should promise. The two fields an admin actually writes that make the
 * page more than a near-empty stub are a free-text description and at
 * least one external assessment; a profile counts as indexable once
 * either is present. A profile that doesn't meet this bar is never
 * hidden, gated, or deleted — it stays fully reachable and usable, just
 * marked `noindex, follow` (see src/app/sources/[id]/page.tsx's
 * generateMetadata) and left out of the sitemap, so search engines don't
 * surface a near-empty page while humans and internal links can still
 * reach it normally.
 */
export function isSourceProfileIndexable(profile: PublicSourceProfile): boolean {
  const hasDescription = (profile.description?.trim().length ?? 0) > 0;
  const hasAssessments = profile.assessments.length > 0;
  return hasDescription || hasAssessments;
}

export function toPublicSourceProfile(source: SourceWithAssessments): PublicSourceProfile {
  return {
    id: source.id,
    name: source.name,
    homepageUrl: source.homepageUrl,
    logoUrl: source.logoUrl,
    categorySlug: source.categorySlug,
    description: source.description,
    sourceType: source.sourceType,
    country: source.country,
    ownership: source.ownership,
    foundedYear: source.foundedYear,
    profileUpdatedAt: source.profileUpdatedAt?.toISOString() ?? null,
    assessments: source.externalAssessments.map((a) => ({
      id: a.id,
      provider: a.provider,
      assessmentType: a.assessmentType,
      ratingValue: a.ratingValue,
      ratingScale: a.ratingScale,
      referenceUrl: a.referenceUrl,
      assessedAt: a.assessedAt?.toISOString() ?? null,
      retrievedAt: a.retrievedAt.toISOString(),
      notes: a.notes,
    })),
  };
}
