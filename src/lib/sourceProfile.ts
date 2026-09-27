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
