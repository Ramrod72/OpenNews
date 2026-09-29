import type { PrismaClient } from "@prisma/client";

/**
 * Phase 13B — a simple ingestion-health signal derived ENTIRELY from
 * existing local data (Source.lastFetchedAt/fetchIntervalMinutes,
 * FeedFetchLog), with no new worker-heartbeat mechanism. The worker is a
 * separate process (worker/index.ts) with no shared in-memory state with
 * the web app, so "is the worker actually alive" can only ever be
 * INFERRED here, never proven — see this module's own naming and the
 * admin UI copy that consumes it: this deliberately never claims the
 * worker is "offline" or "dead," only that specific sources are overdue
 * for their own scheduled fetch, which is the one thing these columns can
 * actually prove.
 *
 * A source is "overdue" once it has gone unfetched for more than
 * OVERDUE_GRACE_MULTIPLIER times its own `fetchIntervalMinutes` — a
 * generous grace period relative to the worker's own tick cadence
 * (WORKER_CRON, default every 5 minutes) so ordinary scheduling jitter
 * never produces a false positive; a source that has NEVER been fetched
 * at all is always overdue regardless of its interval.
 *
 * Only ACTIVE sources are ever considered — a paused source is expected
 * to go unfetched indefinitely, which is not a health problem.
 *
 * This fetches active sources' own timestamp/interval columns only
 * (never full rows, never inactive sources) to compute overdue-ness in
 * application code, because that comparison is inherently per-row
 * (each source has its OWN interval) and cannot be expressed as a single
 * portable SQL predicate without raw, database-specific date arithmetic
 * (this schema deliberately supports both SQLite and Postgres — see
 * schema.prisma's own header comment). This is bounded by the same
 * reasoning already established for the admin sources list itself (Phase
 * 13A's own performance audit): active sources are an operator-curated
 * set, not a user-generated collection, so this can never grow
 * unboundedly the way a users/subscriptions/audit-log table could — and
 * a defensive hard cap is still applied below so this can never become
 * an actual unbounded scan even if that assumption is ever wrong.
 */
const OVERDUE_GRACE_MULTIPLIER = 2;
/** Defensive cap only — real deployments' active-source counts are expected to be far below this. */
const MAX_SOURCES_CONSIDERED = 2000;
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IngestionLivenessStatus {
  activeSourceCount: number;
  overdueSourceCount: number;
  /** Failed FeedFetchLog rows in the last 24h — a bounded, real DB aggregate. */
  recentFailureCount: number;
}

export async function getIngestionLivenessStatus(
  prisma: PrismaClient,
): Promise<IngestionLivenessStatus> {
  const [activeSources, recentFailureCount] = await Promise.all([
    prisma.source.findMany({
      where: { active: true },
      select: { lastFetchedAt: true, fetchIntervalMinutes: true },
      take: MAX_SOURCES_CONSIDERED,
    }),
    prisma.feedFetchLog.count({
      where: {
        success: false,
        startedAt: { gte: new Date(Date.now() - RECENT_FAILURE_WINDOW_MS) },
      },
    }),
  ]);

  const now = Date.now();
  const overdueSourceCount = activeSources.filter((source) => {
    if (!source.lastFetchedAt) return true;
    const graceMs = source.fetchIntervalMinutes * 60_000 * OVERDUE_GRACE_MULTIPLIER;
    return now - source.lastFetchedAt.getTime() > graceMs;
  }).length;

  return {
    activeSourceCount: activeSources.length,
    overdueSourceCount,
    recentFailureCount,
  };
}
