import { Sparkles } from "lucide-react";
import type { AiStoryBriefResult } from "@/lib/ai/storyBrief/generate";
import { UpgradeButton } from "@/components/pricing/UpgradeButton";

/**
 * Phase 11B — "AI story brief." A pure Server Component: receives only
 * the already-generated, already-validated AiStoryBriefResult (see
 * src/lib/aiStoryBrief.ts) and renders it directly. There is deliberately
 * NO Client Component in this feature (unlike Phase 9/10's EvidenceDrawer/
 * ClaimEvidenceDrawer) — the collapse/expand interaction uses a native
 * `<details>` element (zero JS), and reference citations render as plain,
 * non-clickable labels for this MVP (see this file's own doc comment on
 * §25/citation UX below) rather than a scroll-to-anchor interaction,
 * which the Phase 11B spec explicitly allows deferring: "If scroll/
 * highlight adds disproportionate complexity, render clear non-clickable
 * reference labels in 11B... Correctness > UI flourish."
 *
 * Placed on the existing /story/[slug] page immediately after "Common
 * assertions across coverage" (Phase 10) and before the pre-existing
 * "Compare coverage" section — never a new route, never a new heading
 * that collides with either of those.
 *
 * This is a SEPARATE feature from the pre-existing, unrelated
 * `StoryCluster.summary` ("Automated summary," rendered elsewhere on this
 * page, ungated) — see ARCHITECTURE.md's Phase 11B section for the exact
 * distinction. Nothing here reads or writes `StoryCluster.summary`.
 */
export function AiStoryBrief({ result }: { result: AiStoryBriefResult }) {
  if (result.status === "disabled") return null;

  return (
    <section aria-labelledby="ai-story-brief-heading" className="mt-10 scroll-mt-20">
      <details className="rounded-xl border border-border">
        <summary className="cursor-pointer list-none p-4">
          <h2
            id="ai-story-brief-heading"
            className="flex flex-wrap items-center gap-2 text-lg font-bold"
          >
            <Sparkles size={17} aria-hidden /> AI story brief
            <span className="rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-foreground-muted">
              AI-generated
            </span>
          </h2>
        </summary>
        <div className="border-t border-border p-4">
          <AiStoryBriefBody result={result} />
        </div>
      </details>
    </section>
  );
}

function AiStoryBriefBody({ result }: { result: AiStoryBriefResult }) {
  switch (result.status) {
    case "not_entitled":
      return (
        <div className="rounded-xl border border-border bg-surface-muted p-4">
          <p className="mb-2 text-sm">
            Pro members get an AI-generated synthesis of this story&apos;s coverage — common
            assertions, differences, and source-overlap patterns Veriqen has already detected.
          </p>
          <UpgradeButton planName="Pro" />
        </div>
      );
    case "insufficient_data":
      return (
        <p className="text-sm text-foreground-muted">
          Veriqen does not have enough available source information to generate a coverage synthesis
          for this story.
        </p>
      );
    case "quota_exceeded":
      return (
        <p className="text-sm text-foreground-muted">
          You&apos;ve used your AI story briefs for this month. Your quota resets at the start of
          next month.
        </p>
      );
    case "rate_limited":
      return (
        <p className="text-sm text-foreground-muted">
          Please wait a moment before generating another AI story brief.
        </p>
      );
    case "unavailable":
      return (
        <p className="text-sm text-foreground-muted">
          AI story brief is temporarily unavailable for this story.
        </p>
      );
    case "ok":
      return <AiStoryBriefContent result={result} />;
    default:
      return null;
  }
}

function RefChips({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {refs.map((ref) => (
        <span
          key={ref}
          className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted"
        >
          {ref}
        </span>
      ))}
    </span>
  );
}

function AiStoryBriefContent({
  result,
}: {
  result: Extract<AiStoryBriefResult, { status: "ok" }>;
}) {
  const { output, fromCache } = result;
  return (
    <div className="space-y-4">
      <p className="text-base leading-relaxed break-words">
        {output.summary.text}
        <RefChips refs={output.summary.refs} />
      </p>

      <StatementList title="Common assertions across coverage" items={output.commonAssertions} />
      <StatementList title="Differences across coverage" items={output.coverageDifferences} />
      <StatementList title="Reporting-source overlap" items={output.sourceOverlapNotes} />

      {output.unresolvedQuestions.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-bold">Not detected in the available text</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-muted">
            {output.unresolvedQuestions.map((q, i) => (
              <li key={i} className="break-words">
                {q.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <MethodologyDisclosure limitations={output.limitations} />

      {fromCache && (
        <p className="text-xs text-foreground-muted italic">
          Showing a previously generated brief.
        </p>
      )}
    </div>
  );
}

function StatementList({
  title,
  items,
}: {
  title: string;
  items: { text: string; refs: string[] }[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-sm font-bold">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {item.text}
            <RefChips refs={item.refs} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MethodologyDisclosure({ limitations }: { limitations: string[] }) {
  return (
    <details className="rounded-xl border border-border p-4 text-sm">
      <summary className="cursor-pointer font-semibold">How was this generated?</summary>
      <div className="mt-3 space-y-2 text-foreground-muted">
        <p>
          This brief was generated by an AI model using Veriqen&apos;s own structured claim and
          coverage data for this story only — it did not read the full articles, and it may be
          wrong.
        </p>
        <p>
          It does not determine what actually happened, and it never treats repetition across
          articles as independent confirmation.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {limitations.map((line, i) => (
            <li key={i} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
