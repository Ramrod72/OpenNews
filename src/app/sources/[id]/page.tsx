import { notFound } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { Building2, Globe } from "lucide-react";
import {
  getSourceProfile,
  toPublicSourceProfile,
  type PublicAssessment,
} from "@/lib/sourceProfile";
import {
  ASSESSMENT_TYPE_LABELS,
  SOURCE_TYPE_LABELS,
  type AssessmentType,
  type SourceType,
} from "@/lib/validation/sourceProfile";
import { absoluteTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const source = await getSourceProfile(id);
  if (!source) return { title: "Source not found" };
  return { title: source.name, description: source.description ?? undefined };
}

function sourceTypeLabel(sourceType: string | null): string | null {
  if (!sourceType) return null;
  return SOURCE_TYPE_LABELS[sourceType as SourceType] ?? sourceType;
}

function assessmentTypeLabel(assessmentType: string): string {
  return ASSESSMENT_TYPE_LABELS[assessmentType as AssessmentType] ?? assessmentType;
}

export default async function SourceProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = await getSourceProfile(id);
  if (!source) notFound();

  const profile = toPublicSourceProfile(source);

  const grouped = new Map<string, PublicAssessment[]>();
  for (const assessment of profile.assessments) {
    grouped.set(assessment.assessmentType, [
      ...(grouped.get(assessment.assessmentType) ?? []),
      assessment,
    ]);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-4">
        {profile.logoUrl ? (
          <Image
            src={profile.logoUrl}
            alt=""
            width={56}
            height={56}
            unoptimized
            className="h-14 w-14 rounded-lg border border-border object-contain p-1"
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted text-foreground-muted">
            <Building2 size={24} aria-hidden />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{profile.name}</h1>
          {sourceTypeLabel(profile.sourceType) && (
            <p className="text-sm text-foreground-muted">{sourceTypeLabel(profile.sourceType)}</p>
          )}
        </div>
      </div>

      <section className="mb-8 rounded-xl border border-border p-5">
        <h2 className="mb-3 font-bold">About this source</h2>

        {profile.description ? (
          <p className="mb-4 text-sm text-foreground-muted">{profile.description}</p>
        ) : (
          <p className="mb-4 text-sm text-foreground-muted italic">No description on file.</p>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <ProfileField label="Source type" value={sourceTypeLabel(profile.sourceType)} />
          <ProfileField label="Country" value={profile.country} />
          <ProfileField label="Ownership" value={profile.ownership} />
          <ProfileField
            label="Founded"
            value={profile.foundedYear ? String(profile.foundedYear) : null}
          />
        </dl>

        {profile.homepageUrl && (
          <a
            href={profile.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            <Globe size={14} aria-hidden /> Visit website
          </a>
        )}

        <p className="mt-4 text-xs text-foreground-muted">
          {profile.profileUpdatedAt
            ? `Profile last updated ${absoluteTime(profile.profileUpdatedAt)}.`
            : "This profile hasn't been reviewed by an administrator yet."}
        </p>
      </section>

      <section>
        <h2 className="mb-1 font-bold">External assessments</h2>
        <p className="mb-4 max-w-2xl text-sm text-foreground-muted">
          These ratings are published by the third-party organizations named below, using each
          provider&apos;s own methodology. They are not Veriqen News&apos;s independent
          determination, and Veriqen News never averages or combines assessments that disagree.
        </p>

        {profile.assessments.length === 0 ? (
          <EmptyState title="No external assessments on file" />
        ) : (
          <div className="space-y-6">
            {Array.from(grouped.entries()).map(([type, assessments]) => (
              <div key={type}>
                <h3 className="mb-2 text-xs font-bold tracking-wide text-foreground-muted uppercase">
                  {assessmentTypeLabel(type)}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {assessments.map((assessment) => (
                    <AssessmentCard key={assessment.id} assessment={assessment} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        {label}
      </dt>
      <dd className={value ? "" : "text-foreground-muted italic"}>{value ?? "Not listed"}</dd>
    </div>
  );
}

function AssessmentCard({ assessment }: { assessment: PublicAssessment }) {
  return (
    <div className="rounded-lg border border-border p-4 text-sm">
      <p className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Provider
      </p>
      <p className="mb-2 font-bold">{assessment.provider}</p>

      <p className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Assessment
      </p>
      <p className="mb-2">
        {assessment.ratingValue}
        {assessment.ratingScale && (
          <span className="block text-xs text-foreground-muted">
            Scale: {assessment.ratingScale}
          </span>
        )}
      </p>

      <p className="text-xs text-foreground-muted">
        {assessment.assessedAt
          ? `Published ${absoluteTime(assessment.assessedAt)}`
          : "Publication date not disclosed"}
        {" · "}
        Retrieved by Veriqen News {absoluteTime(assessment.retrievedAt)}
      </p>

      {assessment.notes && <p className="mt-2 text-xs text-foreground-muted">{assessment.notes}</p>}

      {assessment.referenceUrl && (
        <a
          href={assessment.referenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
        >
          View source of this rating
        </a>
      )}
    </div>
  );
}
