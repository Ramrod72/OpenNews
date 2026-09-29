import { prisma } from "@/lib/db";
import { getBillingAdminStatus, type BillingAdminStatus } from "@/lib/billing/adminStatus";
import { getRecentAdminActions } from "@/lib/adminAudit";
import { absoluteTime, relativeTime } from "@/lib/format";

// See src/app/admin/(protected)/sources/page.tsx's own comment on this
// directive — every admin page reading live data needs it.
export const dynamic = "force-dynamic";

const AUDIT_LOG_TAIL_LIMIT = 50;

type AuditRow = Awaited<ReturnType<typeof getRecentAdminActions>>[number];

/**
 * Detailed, read-only operational view — billing status/subscription
 * counts and a bounded recent-mutation tail. Both optional sections are
 * fetched via Promise.allSettled and degrade independently on failure
 * (see this file's own render helpers) — this page must never throw
 * wholesale because one of two informational aggregates had a transient
 * error. No live Stripe call is ever made here (see
 * src/lib/billing/adminStatus.ts's own doc comment) and no mutation
 * endpoint of any kind lives on this page or its route.
 */
export default async function AdminOperationsPage() {
  const [billingResult, auditResult] = await Promise.allSettled([
    getBillingAdminStatus(prisma),
    getRecentAdminActions(prisma, AUDIT_LOG_TAIL_LIMIT),
  ]);
  const billing = billingResult.status === "fulfilled" ? billingResult.value : null;
  const auditLog = auditResult.status === "fulfilled" ? auditResult.value : null;

  return (
    <div>
      <h1 className="mb-2 text-2xl font-extrabold tracking-tight">Operations</h1>
      <p className="mb-6 text-sm text-foreground-muted">
        Read-only operational status. Billing changes (plans, cancellations, refunds) are made in
        Stripe or the Customer Portal — nothing here can create, modify, or cancel a subscription.
      </p>

      <BillingDetail billing={billing} />

      <div className="mt-8">
        <AuditLogTail rows={auditLog} />
      </div>
    </div>
  );
}

function BillingDetail({ billing }: { billing: BillingAdminStatus | null }) {
  if (!billing) {
    return (
      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-2 font-bold">Billing</h2>
        <p className="text-sm text-foreground-muted">Status temporarily unavailable.</p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="mb-2 font-bold">Billing</h2>
      {billing.enabled ? (
        <p className="mb-3 text-sm text-success">Configured — mode: {billing.mode}</p>
      ) : (
        <p className="mb-3 text-sm text-foreground-muted">
          Not configured — {billing.disabledReason}
        </p>
      )}

      <p className="mb-1 text-sm font-semibold">Local subscriptions by status</p>
      {billing.subscriptionsByStatus.length === 0 ? (
        <p className="mb-3 text-sm text-foreground-muted">No subscriptions recorded yet.</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm">
          {billing.subscriptionsByStatus.map((row) => (
            <li key={row.status} className="flex items-center justify-between">
              <span className="text-foreground-muted">{row.status}</span>
              <span className="font-medium">{row.count}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-foreground-muted">
        {billing.neverSyncedCount > 0 ? (
          <span className="text-breaking">
            {billing.neverSyncedCount} subscription{billing.neverSyncedCount === 1 ? "" : "s"} never
            confirmed by Stripe (billingProvider set, lastSyncedAt still null).
          </span>
        ) : (
          "No subscriptions are missing Stripe confirmation."
        )}
      </p>
      <p className="mt-2 text-xs text-foreground-muted">
        An unexpected duplicate Stripe subscription for one user is detected and logged server-side
        only for this release — it is not yet surfaced in this dashboard.
      </p>
    </section>
  );
}

function AuditLogTail({ rows }: { rows: AuditRow[] | null }) {
  if (!rows) {
    return (
      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-2 font-bold">Recent admin activity</h2>
        <p className="text-sm text-foreground-muted">Activity log temporarily unavailable.</p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="mb-2 font-bold">Recent admin activity</h2>
      <p className="mb-3 text-xs text-foreground-muted">
        The last {AUDIT_LOG_TAIL_LIMIT} administrative mutations, newest first. Read-only page views
        are never recorded.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">No administrative mutations recorded yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3">
              <span className="font-medium">{row.summary}</span>
              <span
                className="shrink-0 text-xs text-foreground-muted"
                title={absoluteTime(row.occurredAt)}
              >
                {relativeTime(row.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
