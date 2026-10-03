"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { OriginalReportingView, ReportingSourceGroupView } from "@/lib/storyIntelligenceView";

/**
 * Phase 9B's only Client Component: the expandable "full reporting-source
 * breakdown" for viewers entitled to it. It receives nothing but the
 * already-safe, already-entitlement-filtered view model built by
 * src/lib/storyIntelligenceView.ts — no ClusterOriginSummary, no
 * observationId/entityId/extractorVersion/confidence enum ever reaches
 * this component or its props (and therefore never serializes into the
 * page's client payload).
 *
 * The outer expand/collapse (this whole breakdown) uses the same
 * aria-expanded/aria-controls button pattern as ShareButton.tsx. Each
 * individual group's article list + evidence uses a native <details>
 * element — no extra state needed, and it's keyboard/screen-reader
 * accessible by default.
 */
export function EvidenceDrawer({
  reportingSourceGroups,
  originalReporting,
}: {
  reportingSourceGroups: ReportingSourceGroupView[];
  originalReporting: OriginalReportingView | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const hasContent =
    reportingSourceGroups.length > 0 || (originalReporting?.items?.length ?? 0) > 0;
  if (!hasContent) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted"
      >
        <ChevronDown
          size={15}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
        {open ? "Hide full sourcing breakdown" : "Show full sourcing breakdown"}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Full sourcing breakdown"
          className="mt-4 space-y-4"
        >
          {reportingSourceGroups.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold">Reporting sources</h3>
              <div className="space-y-2">
                {reportingSourceGroups.map((group) => (
                  <ReportingSourceGroupDetails key={group.key} group={group} />
                ))}
              </div>
            </div>
          )}

          {originalReporting?.items && originalReporting.items.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold">Original reporting</h3>
              <p className="mb-2 text-xs text-foreground-muted">
                Veriqen News detected language associated with original reporting in these articles.
                This is not an independence or reliability judgment.
              </p>
              <ul className="space-y-3">
                {originalReporting.items.map((item, i) => (
                  <EvidenceEntry key={`${item.articleId}-${i}`} item={item} />
                ))}
              </ul>
              {originalReporting.items.length < originalReporting.count && (
                <p className="mt-2 text-xs text-foreground-muted italic">
                  Showing {originalReporting.items.length} of {originalReporting.count} articles.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReportingSourceGroupDetails({ group }: { group: ReportingSourceGroupView }) {
  const verb = group.kind === "reporting_intermediary" ? "Cited by" : "Referenced by";
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold break-words">
        {group.entityName}{" "}
        <span className="font-normal text-foreground-muted">
          — {verb.toLowerCase()} {group.articleCount} article{group.articleCount === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {group.evidence && group.evidence.length > 0 ? (
          <ul className="space-y-3">
            {group.evidence.map((item, i) => (
              <EvidenceEntry key={`${item.articleId}-${i}`} item={item} />
            ))}
          </ul>
        ) : (
          group.articles && (
            <ul className="space-y-2">
              {group.articles.map((a) => (
                <li key={a.articleId} className="text-sm">
                  <ArticleLinkLine article={a} />
                </li>
              ))}
            </ul>
          )
        )}
        {/* group.articles always reflects the true displayed count (see
            MAX_ARTICLES_PER_GROUP_DISPLAY in storyIntelligenceView.ts), even
            when `evidence` is what's actually rendered above — so this
            comparison is accurate either way. */}
        {group.articles && group.articles.length < group.articleCount && (
          <p className="text-xs text-foreground-muted italic">
            Showing {group.articles.length} of {group.articleCount} articles.
          </p>
        )}
      </div>
    </details>
  );
}

function EvidenceEntry({
  item,
}: {
  item: {
    articleId: string;
    title: string;
    url: string;
    publisherName: string;
    publisherSourceId: string;
    evidenceText: string;
  };
}) {
  return (
    <li className="rounded-md bg-surface-muted p-3 text-sm">
      <ArticleLinkLine article={item} />
      <blockquote className="mt-1.5 border-l-2 border-border pl-2 text-foreground-muted italic break-words">
        &ldquo;{item.evidenceText}&rdquo;
      </blockquote>
    </li>
  );
}

function ArticleLinkLine({
  article,
}: {
  article: { title: string; url: string; publisherName: string; publisherSourceId: string };
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <Link
        href={`/sources/${article.publisherSourceId}`}
        className="font-medium text-foreground-muted hover:text-accent hover:underline"
      >
        {article.publisherName}
      </Link>
      {article.url ? (
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-semibold break-words hover:text-accent hover:underline"
        >
          {article.title} <ExternalLink size={12} aria-hidden />
        </a>
      ) : (
        // storyIntelligenceView.ts's safeArticleHref already filtered out
        // any non-http(s) article URL (javascript:, data:, ...) — an empty
        // url here means no safe link exists, so the title renders as plain
        // text rather than a clickable, potentially unsafe anchor.
        <span className="font-semibold break-words">{article.title}</span>
      )}
    </div>
  );
}
