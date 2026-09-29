import type { PrismaClient } from "@prisma/client";

/**
 * Minimal administrative mutation audit log (Phase 13B). This is the ONLY
 * writer of AdminAuditLog — see that model's own doc comment in
 * schema.prisma for why no admin-identity column exists yet.
 *
 * Every call site is responsible for building its own short,
 * pre-redacted `summary` string BEFORE calling this function — this
 * module never accepts a raw request body, error object, or any other
 * unbounded/untrusted value, and defensively truncates `summary` as a
 * last-resort backstop against a future call-site bug (never relied on
 * as the actual redaction mechanism; the actual mechanism is "callers
 * only ever pass a fixed, hand-written string").
 *
 * Logging failures are swallowed: writing an audit row is a compensating
 * control, never a dependency the real admin mutation can fail because
 * of. A failed audit write means one fewer log line, not a broken admin
 * panel — see ARCHITECTURE.md's Phase 13 section.
 */

/** Closed set of recorded action keys — never a free-form/derived string, so a bug can't invent a new action name at runtime. */
export const ADMIN_AUDIT_ACTIONS = [
  "source.create",
  "source.update",
  "source.delete",
  "assessment.create",
  "assessment.update",
  "assessment.delete",
  "category.update",
  "settings.update.ads",
  "settings.update.ai",
  "ingest.trigger",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** Defensive cap only — real call sites should never approach this length. */
const MAX_SUMMARY_CHARS = 300;

export interface LogAdminActionParams {
  action: AdminAuditAction;
  targetType?: string;
  targetId?: string;
  summary: string;
  success?: boolean;
}

export async function logAdminAction(
  prisma: PrismaClient,
  params: LogAdminActionParams,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        summary: params.summary.slice(0, MAX_SUMMARY_CHARS),
        success: params.success ?? true,
      },
    });
  } catch {
    // Never let a logging failure surface to the caller — see this
    // module's own doc comment.
  }
}

/** Bounded, newest-first tail for the read-only recent-activity view — the only read path this module exposes. */
export async function getRecentAdminActions(prisma: PrismaClient, limit = 50) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  return prisma.adminAuditLog.findMany({
    orderBy: { occurredAt: "desc" },
    take: boundedLimit,
  });
}
