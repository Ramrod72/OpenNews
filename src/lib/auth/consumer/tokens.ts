import { randomBytes, createHash } from "node:crypto";

/** A random opaque session token — not a JWT, not signed, carries no data. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only this hash is ever stored in the database (AuthSession.tokenHash).
 * The raw token lives solely in the browser's httpOnly cookie, so reading
 * the database alone (e.g. via a read-only compromise) can never produce a
 * valid session token.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
