"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { ClaimGroupView, ClaimOccurrenceView } from "@/lib/coverageComparisonView";

/**
 * Phase 10B's only Client Component: the expandable per-claim-group
 * occurrence list for viewers entitled to it (claim_comparison / Pro).
 * Receives nothing but the already-safe, already-entitlement-filtered
 * ClaimGroupView[] built by src/lib/coverageComparisonView.ts — no Claim,
 * ClaimGroup, or ProvenanceEntity ever reaches this component or its
 * props (and therefore never serializes into the page's client payload).
 *
 * Mirrors EvidenceDrawer.tsx's exact pattern: the outer expand/collapse
 * uses the same aria-expanded/aria-controls button; each group's
 * occurrence list uses a native <details> element.
 */
export function ClaimEvidenceDrawer({ claimGroups }: { claimGroups: ClaimGroupView[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const groupsWithOccurrences = claimGroups.filter((g) => (g.occurrences?.length ?? 0) > 0);
  if (groupsWithOccurrences.length === 0) return null;

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
        {open ? "Hide article-by-article breakdown" : "Show article-by-article breakdown"}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Article-by-article claim breakdown"
          className="mt-4 space-y-2"
        >
          {groupsWithOccurrences.map((group) => (
            <ClaimGroupDetails key={group.key} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimGroupDetails({ group }: { group: ClaimGroupView }) {
  const occurrences = group.occurrences ?? [];
  const truncated = occurrences.length < group.articleCount;
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold break-words">
        {group.text}{" "}
        <span className="font-normal text-foreground-muted">
          — {group.articleCount} article{group.articleCount === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <ul className="space-y-2">
          {occurrences.map((occ) => (
            <li key={occ.articleId} className="text-sm">
              <OccurrenceLine occurrence={occ} />
            </li>
          ))}
        </ul>
        {truncated && (
          <p className="text-xs text-foreground-muted italic">
            Showing {occurrences.length} of {group.articleCount} articles.
          </p>
        )}
      </div>
    </details>
  );
}

function OccurrenceLine({ occurrence }: { occurrence: ClaimOccurrenceView }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <Link
          href={`/sources/${occurrence.publisherSourceId}`}
          className="font-medium text-foreground-muted hover:text-accent hover:underline"
        >
          {occurrence.publisherName}
        </Link>
        {occurrence.url ? (
          <a
            href={occurrence.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold break-words hover:text-accent hover:underline"
          >
            {occurrence.title} <ExternalLink size={12} aria-hidden />
          </a>
        ) : (
          // coverageComparisonView.ts's safeHttpUrl-based sanitization
          // already filtered out any non-http(s) article URL — an empty
          // url here means no safe link exists.
          <span className="font-semibold break-words">{occurrence.title}</span>
        )}
      </div>
      {occurrence.text && (
        <blockquote className="mt-1 border-l-2 border-border pl-2 text-xs text-foreground-muted italic break-words">
          &ldquo;{occurrence.text}&rdquo;
        </blockquote>
      )}
    </div>
  );
}
