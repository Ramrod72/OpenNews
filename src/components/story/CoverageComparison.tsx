import { Scale } from "lucide-react";
import type { CoverageComparisonResult } from "@/lib/coverageComparisonView";
import { UpgradeButton } from "@/components/pricing/UpgradeButton";
import { ClaimEvidenceDrawer } from "@/components/story/ClaimEvidenceDrawer";

/**
 * Phase 10B: "Common assertions across coverage" — the Coverage
 * Comparison section on the existing /story/[slug] page, placed after
 * "Trace this story" (Phase 9). Deliberately NOT titled "Compare
 * coverage" in the heading despite that being this feature's product
 * name elsewhere: the page already has a pre-existing "Compare coverage"
 * section (id="compare", per-outlet headline/timing comparison) — an
 * identical duplicate H2 heading on the same page would confuse readers
 * and break heading-hierarchy navigation, so this section uses "Common
 * assertions across coverage" (itself locked-approved consumer
 * terminology) as its actual heading text instead.
 *
 * A Server Component: receives the already-loaded, already-entitlement-
 * filtered CoverageComparisonView (see src/lib/coverageComparison.ts) and
 * renders it directly. The only Client Component is <ClaimEvidenceDrawer>,
 * which only ever receives this same safe view model — never a raw Claim,
 * ClaimGroup, or ProvenanceObservation-shaped object.
 *
 * Core principle this component must never violate: Veriqen describes
 * observable differences in reporting — it does not infer motive, does
 * not treat repetition as corroboration, and does not treat "not detected
 * in the available text" as "omitted."
 */
export function CoverageComparison({ comparison }: { comparison: CoverageComparisonResult }) {
  if (comparison.status === "unavailable") {
    return (
      <section aria-labelledby="compare-coverage-claims-heading" className="mt-10 scroll-mt-20">
        <h2
          id="compare-coverage-claims-heading"
          className="mb-3 flex items-center gap-2 text-lg font-bold"
        >
          <Scale size={17} /> Common assertions across coverage
        </h2>
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-foreground-muted">
          Coverage comparison details are temporarily unavailable.
        </p>
      </section>
    );
  }

  const {
    articleCount,
    publisherCount,
    claimGroups,
    totalClaimGroupCount,
    headlineComparison,
    hasFullAccess,
    limitationsNote,
  } = comparison;

  const hiddenGroupCount = totalClaimGroupCount - claimGroups.length;
  const hasAnyContent = claimGroups.length > 0 || (headlineComparison?.entries.length ?? 0) > 0;

  return (
    <section aria-labelledby="compare-coverage-claims-heading" className="mt-10 scroll-mt-20">
      <h2
        id="compare-coverage-claims-heading"
        className="mb-1 flex items-center gap-2 text-lg font-bold"
      >
        <Scale size={17} /> Common assertions across coverage
      </h2>
      <p className="mb-4 text-sm text-foreground-muted">
        {articleCount} article{articleCount === 1 ? "" : "s"} · {publisherCount} publisher
        {publisherCount === 1 ? "" : "s"}
      </p>

      {!hasAnyContent && (
        <p className="mb-3 text-sm text-foreground-muted">
          Veriqen did not detect comparable assertions in the available text for this story.
        </p>
      )}

      {claimGroups.length > 0 && (
        <ul className="mb-3 space-y-1.5 text-sm">
          {claimGroups.map((group) => (
            <li key={group.key} className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold break-words">{group.text}</span>
              <span className="text-foreground-muted">
                — appears in {group.articleCount} article{group.articleCount === 1 ? "" : "s"}
                {group.publisherCount > 0 &&
                  ` (${group.publisherCount} publisher${group.publisherCount === 1 ? "" : "s"})`}
              </span>
            </li>
          ))}
          {!hasFullAccess && hiddenGroupCount > 0 && (
            <li className="text-xs text-foreground-muted italic">
              +{hiddenGroupCount} more shared assertion{hiddenGroupCount === 1 ? "" : "s"} detected
            </li>
          )}
        </ul>
      )}

      {hasFullAccess && claimGroups.some((g) => (g.sourceOverlap?.length ?? 0) > 0) && (
        <ul className="mb-3 space-y-1 text-xs text-foreground-muted">
          {claimGroups
            .filter((g) => (g.sourceOverlap?.length ?? 0) > 0)
            .flatMap((g) =>
              // Each source-overlap entry gets its OWN line: joining multiple
              // entity names together while showing only one entry's count
              // would misrepresent a different entity's actual overlap count
              // as if it applied to all of them (e.g. "Reuters, AP cited by
              // 9 of 15" when AP's real count is 3) — regression-tested in
              // coverageComparisonSafety.test.ts.
              g.sourceOverlap!.map((overlap) => (
                <li key={`${g.key}-overlap-${overlap.entityName}`}>
                  {overlap.entityName} cited by {overlap.overlapArticleCount} of the{" "}
                  {g.articleCount} articles reporting: &ldquo;{g.text}&rdquo;
                </li>
              )),
            )}
        </ul>
      )}

      {headlineComparison && headlineComparison.entries.length > 0 && (
        <div className="mb-3">
          <h3 className="mb-1 text-sm font-bold">Headline differences</h3>
          <ul className="space-y-1 text-sm">
            {headlineComparison.entries.map((entry) => (
              <li key={entry.articleId} className="text-xs text-foreground-muted">
                <span className="font-medium text-foreground">{entry.publisherName}:</span>{" "}
                {entry.title}
                {entry.perspective !== "reporting" && (
                  <span className="ml-1 italic">
                    (publisher-labeled {entry.perspective === "opinion" ? "opinion" : "analysis"})
                  </span>
                )}
              </li>
            ))}
          </ul>
          {headlineComparison.sharedEntities.length > 0 && (
            <p className="mt-1 text-xs text-foreground-muted">
              Mentioned across multiple headlines: {headlineComparison.sharedEntities.join(", ")}
            </p>
          )}
          {headlineComparison.truncated && (
            <p className="mt-1 text-xs text-foreground-muted italic">
              Upgrade to see headlines from every article in this story.
            </p>
          )}
        </div>
      )}

      {hasFullAccess ? (
        <ClaimEvidenceDrawer claimGroups={claimGroups} />
      ) : (
        <div className="mt-4 rounded-xl border border-border bg-surface-muted p-4">
          <p className="mb-2 text-sm">
            Basic and Pro members see the full coverage comparison, including every shared
            assertion, headline differences across all articles, and reporting-source context.
          </p>
          <UpgradeButton planName="Basic" planSlug="basic" />
        </div>
      )}

      <p className="mt-4 text-xs text-foreground-muted">{limitationsNote}</p>

      <MethodologyDisclosure />
    </section>
  );
}

function MethodologyDisclosure() {
  return (
    <details className="mt-3 rounded-xl border border-border p-4 text-sm">
      <summary className="cursor-pointer font-semibold">How Veriqen compares coverage</summary>
      <div className="mt-3 space-y-2 text-foreground-muted">
        <p>
          Veriqen looks for two kinds of explicit, structured assertions in the article text
          available to it: numbers tied to a recognized category (like a count of people injured, a
          dollar amount, or a percentage), and statements attributed to a named or role-based
          source. Similar assertions found across multiple articles in this story are grouped
          together and shown as one entry.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            &ldquo;Appears in N articles&rdquo; counts how many articles contain a similar assertion
            — it does not mean N sources independently confirmed it. Articles that cite the same
            reporting source (shown separately, where detected) are not independent of each other.
          </li>
          <li>Not all comparable assertions are written explicitly, so some go undetected.</li>
          <li>
            &ldquo;Not detected in the available text&rdquo; never means an article has no sources.
          </li>
          <li>
            Attribution to a source is not a claim that the underlying statement is true — only that
            it was attributed.
          </li>
          <li>
            Veriqen does not assess whether any claim, outlet, or headline is accurate or biased.
          </li>
        </ul>
      </div>
    </details>
  );
}
