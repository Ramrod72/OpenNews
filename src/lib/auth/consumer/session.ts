import { prisma } from "@/lib/db";
import { generateSessionToken, hashToken } from "./tokens";
import { SESSION_TTL_MS } from "./sessionOptions";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
}

export interface NewSession {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a brand-new session for a user (registration or successful
 * login). Always mints a fresh random token and a fresh AuthSession row
 * — never reuses or "upgrades" an existing token — which is what rules
 * out session fixation: there is no code path where a pre-set cookie
 * value can become authenticated.
 */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<NewSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ipAddress ?? null,
    },
  });

  return { token, expiresAt };
}

/**
 * Resolves a raw session token (already hashed by the caller) to its
 * user, or null if the token is missing, unknown, revoked, or expired.
 * Takes the hash directly (rather than reading the cookie itself) so
 * this — the actual authorization-relevant logic — is plain Prisma code,
 * testable without any dependency on Next's request-scoped `cookies()`.
 */
export async function resolveSessionUser(
  tokenHash: string | undefined | null,
): Promise<SessionUser | null> {
  if (!tokenHash) return null;

  const session = await prisma.authSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return null;
  }

  // Best-effort activity timestamp; not security-relevant if this write
  // races or is skipped, so no need to serialize it.
  prisma.authSession
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  const { id, email, displayName, createdAt } = session.user;
  return { id, email, displayName, createdAt };
}

/** Logout: revokes the session so it can never be resolved again, even if the cookie is replayed. */
export async function revokeSession(tokenHash: string | undefined | null): Promise<void> {
  if (!tokenHash) return;
  await prisma.authSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
