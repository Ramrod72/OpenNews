/**
 * Cookie name and options for the consumer session, kept intentionally
 * distinct from the admin session (src/lib/auth/sessionOptions.ts,
 * cookie "opennews_admin_session") — different name, different cookie,
 * different verification mechanism (this one is an opaque DB-backed
 * token, not a signed/encrypted iron-session payload).
 */
export const SESSION_COOKIE_NAME = "veriqen_session";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000, // seconds, for the Set-Cookie header
};
