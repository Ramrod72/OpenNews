import { prisma } from "@/lib/db";
import { getBillingAdminStatus, type BillingAdminStatus } from "@/lib/billing/adminStatus";
import {
  getIngestionLivenessStatus,
  type IngestionLivenessStatus,
} from "@/lib/ingest/adminLiveness";
import { RunIngestButton } from "./RunIngestButton";

// See src/app/admin/(protected)/sources/page.tsx's own comment on this
// directive — every admin page reading live data needs it, and this one
// especially: the whole point of billing/ingestion visibility is that it
// reflects CURRENT state, not a build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Every optional operational section below (billing status, ingestion
 * liveness) is fetched via Promise.allSettled and rendered defensively —
 * a failure in ONE section (e.g. a transient DB hiccup on the billing
 * aggregate) must never blank the rest of the dashboard, and must never
 * throw the whole page into Next's generic error boundary. The core
 * counts (sources/articles/clusters/recent failures) are the one thing
 * this page has always required the database for; if those fail, the
 * page failing is the existing, unchanged behavior — this file adds
 * failure ISOLATION for the two new optional sections, not a new
 * guarantee that the whole page survives a total database outage.
 */
export default async function AdminDashboardPage() {
  const [
    sourceCount,
    activeSourceCount,
    articleCount,
    clusterCount,
    breakingCount,
    recentFailures,
  ] = await Promise.all([
    prisma.source.count(),
    prisma.source.count({ where: { active: true } }),
    prisma.article.count(),
    prisma.storyCluster.count(),
    prisma.storyCluster.count({ where: { breaking: true } }),
    prisma.feedFetchLog.findMany({
      where: { success: false },
      orderBy: { startedAt: "desc" },
      take: 5,
      include: { source: { select: { name: true } } },
    }),
  ]);

  const [billingResult, livenessResult] = await Promise.allSettled([
    getBillingAdminStatus(prisma),
    getIngestionLivenessStatus(prisma),
  ]);
  const billing = billingResult.status === "fulfilled" ? billingResult.value : null;
  const liveness = livenessResult.status === "fulfilled" ? livenessResult.value : null;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Sources" value={`${activeSourceCount}/${sourceCount}`} hint="active/total" />
        <Stat label="Articles" value={articleCount.toLocaleString()} />
        <Stat label="Story clusters" value={clusterCount.toLocaleString()} />
        <Stat label="Breaking now" value={breakingCount.toLocaleString()} />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <IngestionLivenessCard liveness={liveness} />
        <BillingStatusCard billing={billing} />
      </div>

      <div className="mb-8 rounded-xl border border-border p-4">
        <p className="mb-2 font-bold">Manual ingestion</p>
        <p className="mb-3 text-sm text-foreground-muted">
          The worker process fetches feeds automatically on a schedule. Trigger an immediate run
          here (e.g. right after adding a source).
        </p>
        <RunIngestButton />
      </div>

      {recentFailures.length > 0 && (
        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 font-bold">Recent feed failures</p>
          <ul className="space-y-1.5 text-sm">
            {recentFailures.map((log) => (
              <li key={log.id} className="flex items-center justify-between gap-3">
                <span className="font-medium">{log.source.name}</span>
                <span className="truncate text-xs text-foreground-muted">{log.errorMessage}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function IngestionLivenessCard({ liveness }: { liveness: IngestionLivenessStatus | null }) {
  if (!liveness) {
    return (
      <div className="rounded-xl border border-border p-4">
        <p className="mb-1 font-bold">Ingestion</p>
        <p className="text-sm text-foreground-muted">Status temporarily unavailable.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="mb-1 font-bold">Ingestion</p>
      <p className="text-sm text-foreground-muted">{liveness.activeSourceCount} active sources</p>
      <p className="text-sm">
        {liveness.overdueSourceCount > 0 ? (
          <span className="text-breaking">
            {liveness.overdueSourceCount} source{liveness.overdueSourceCount === 1 ? "" : "s"}{" "}
            overdue for scheduled fetch
          </span>
        ) : (
          <span className="text-success">All active sources fetched on schedule</span>
        )}
      </p>
      {liveness.recentFailureCount > 0 && (
        <p className="text-xs text-foreground-muted">
          {liveness.recentFailureCount} feed fetch failure
          {liveness.recentFailureCount === 1 ? "" : "s"} in the last 24h
        </p>
      )}
    </div>
  );
}

function BillingStatusCard({ billing }: { billing: BillingAdminStatus | null }) {
  if (!billing) {
    return (
      <div className="rounded-xl border border-border p-4">
        <p className="mb-1 font-bold">Billing</p>
        <p className="text-sm text-foreground-muted">Status temporarily unavailable.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="mb-1 font-bold">Billing</p>
      {billing.enabled ? (
        <p className="text-sm text-success">Configured ({billing.mode})</p>
      ) : (
        <p className="text-sm text-foreground-muted">Not configured — {billing.disabledReason}</p>
      )}
      {billing.neverSyncedCount > 0 && (
        <p className="text-xs text-breaking">
          {billing.neverSyncedCount} subscription{billing.neverSyncedCount === 1 ? "" : "s"} never
          confirmed by Stripe
        </p>
      )}
      <a href="/admin/operations" className="text-xs text-accent hover:underline">
        View details →
      </a>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-2xl font-extrabold">{value}</p>
      <p className="text-xs text-foreground-muted">
        {label}
        {hint && <span className="opacity-70"> ({hint})</span>}
      </p>
    </div>
  );
}
