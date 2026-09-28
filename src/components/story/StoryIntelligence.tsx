import { Compass } from "lucide-react";
import type { StoryIntelligenceResult } from "@/lib/storyIntelligenceView";
import { UpgradeButton } from "@/components/pricing/UpgradeButton";
import { EvidenceDrawer } from "@/components/story/EvidenceDrawer";

/**
 * Phase 9B: "Trace this story" — the Story Intelligence section on the
 * existing /story/[slug] page. A Server Component: it receives the
 * already-loaded, already-entitlement-filtered StoryIntelligenceResult
 * (see src/lib/storyIntelligence.ts) and renders it directly. The only
 * Client Component in this feature is <EvidenceDrawer>, and it only ever
 * receives the same safe view-model data this component already has —
 * never the raw ClusterOriginSummary.
 *
 * Core principle this component must never violate: Veriqen traces
 * attribution, it does not determine truth. Nothing here may say a
 * source "verified," "confirmed," or "proved" anything, and shared
 * attribution to one entity is never described as independent
 * confirmation.
 */
export function StoryIntelligence({ intelligence }: { intelligence: StoryIntelligenceResult }) {
  if (intelligence.status === "unavailable") {
    return (
      <section aria-labelledby="trace-this-story-heading" className="mt-10 scroll-mt-20">
        <h2
          id="trace-this-story-heading"
          className="mb-3 flex items-center gap-2 text-lg font-bold"
        >
          <Compass size={17} /> Trace this story
        </h2>
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-foreground-muted">
          Story sourcing details are temporarily unavailable.
        </p>
      </section>
    );
  }

  const {
    articleCount,
    publisherCount,
    hasFullAccess,
    reportingSourceGroups,
    totalReportingSourceGroupCount,
    originalReporting,
    sourcingNotDetectedCount,
  } = intelligence;

  const previewGroups = hasFullAccess ? reportingSourceGroups.slice(0, 2) : reportingSourceGroups;
  const hiddenGroupCount = totalReportingSourceGroupCount - previewGroups.length;

  // Every article in the cluster has zero persisted observations of any
  // kind — the strongest, most specific "nothing detected" case, distinct
  // from "something was detected but never formed a shared group."
  const detectedNothingAtAll = articleCount > 0 && sourcingNotDetectedCount === articleCount;

  let emptyStateMessage: string | null = null;
  if (articleCount <= 1) {
    emptyStateMessage =
      "Only one article is currently linked to this story — sourcing comparisons need more than one.";
  } else if (detectedNothingAtAll) {
    emptyStateMessage =
      "Veriqen did not detect explicit sourcing language in the available article text for this story.";
  } else if (totalReportingSourceGroupCount === 0) {
    emptyStateMessage = "No two articles in this story cite the same identifiable source yet.";
  }

  return (
    <section aria-labelledby="trace-this-story-heading" className="mt-10 scroll-mt-20">
      <h2 id="trace-this-story-heading" className="mb-1 flex items-center gap-2 text-lg font-bold">
        <Compass size={17} /> Trace this story
      </h2>
      <p className="mb-4 text-sm text-foreground-muted">
        {articleCount} article{articleCount === 1 ? "" : "s"} · {publisherCount} publisher
        {publisherCount === 1 ? "" : "s"}
      </p>

      {previewGroups.length > 0 && (
        <ul className="mb-3 space-y-1.5 text-sm">
          {previewGroups.map((group) => (
            <li key={group.key} className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold">{group.entityName}</span>
              <span className="text-foreground-muted">
                {group.kind === "reporting_intermediary" ? "— cited by" : "— referenced by"}{" "}
                {group.articleCount} article{group.articleCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          {!hasFullAccess && hiddenGroupCount > 0 && (
            <li className="text-xs text-foreground-muted italic">
              +{hiddenGroupCount} more reporting source{hiddenGroupCount === 1 ? "" : "s"} detected
            </li>
          )}
        </ul>
      )}

      {emptyStateMessage && (
        <p className="mb-3 text-sm text-foreground-muted">{emptyStateMessage}</p>
      )}

      {originalReporting && (
        <p className="mb-3 text-sm text-foreground-muted">
          Veriqen detected language associated with original reporting in {originalReporting.count}{" "}
          article{originalReporting.count === 1 ? "" : "s"}.
        </p>
      )}

      {!detectedNothingAtAll && sourcingNotDetectedCount > 0 && (
        <p className="mb-3 text-sm text-foreground-muted">
          Sourcing not detected in {sourcingNotDetectedCount} article
          {sourcingNotDetectedCount === 1 ? "" : "s"}.{" "}
          <span className="text-xs">
            (Veriqen did not detect explicit sourcing language in the available article text — this
            does not mean the article has no sources.)
          </span>
        </p>
      )}

      {hasFullAccess ? (
        <EvidenceDrawer
          reportingSourceGroups={reportingSourceGroups}
          originalReporting={originalReporting}
        />
      ) : (
        <div className="mt-4 rounded-xl border border-border bg-surface-muted p-4">
          <p className="mb-2 text-sm">
            Basic and Pro members see the full reporting-source breakdown, article-by-article
            evidence, and original-reporting details for every story.
          </p>
          <UpgradeButton planName="Basic" />
        </div>
      )}

      <HowVeriqenTraces />
    </section>
  );
}

function HowVeriqenTraces() {
  return (
    <details className="mt-5 rounded-xl border border-border p-4 text-sm">
      <summary className="cursor-pointer font-semibold">How Veriqen traces this</summary>
      <div className="mt-3 space-y-2 text-foreground-muted">
        <p>
          Veriqen analyzes the article text available from publishers and looks for explicit
          sourcing language, such as references to reporting organizations, agencies, statements,
          and other identifiable sources. Articles that cite the same identified source can then be
          grouped together.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Not all sourcing is written explicitly, so some real sourcing goes undetected.</li>
          <li>Publisher feeds may provide limited article text to analyze.</li>
          <li>
            Two articles citing the same source do not necessarily use the same report or come from
            the same origin.
          </li>
          <li>No detected sourcing does not mean an article has no sources.</li>
          <li>
            Veriqen traces attribution — it does not determine whether a claim is true or false.
          </li>
        </ul>
      </div>
    </details>
  );
}
