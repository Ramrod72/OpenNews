import { cookies } from "next/headers";
import { hashToken } from "./tokens";
import { resolveSessionUser, type SessionUser } from "./session";
import { SESSION_COOKIE_NAME } from "./sessionOptions";

/**
 * Thin glue for server components/route handlers: reads the raw token
 * from the request's cookies (only possible inside a real Next.js request
 * scope) and delegates the actual lookup to resolveSessionUser, which is
 * plain Prisma code and has no such restriction — that split is what
 * keeps the authorization logic itself unit-testable.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return resolveSessionUser(hashToken(token));
}

export async function getCurrentSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}
