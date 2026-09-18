import type { SessionOptions } from "iron-session";

export interface AdminSessionData {
  isAdmin?: boolean;
}

const password = process.env.SESSION_SECRET;
if (!password && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] SESSION_SECRET is not set. Admin login will not work until it is configured " +
      "(see .env.example) — generate one with `openssl rand -base64 32`.",
  );
}

/**
 * Plain config only (no next/headers import) so it can be safely imported
 * from both server components/route handlers (via session.ts) and
 * middleware.ts, which runs in a restricted runtime that disallows
 * next/headers.
 */
export const sessionOptions: SessionOptions = {
  password: password || "dev-only-insecure-secret-please-set-SESSION_SECRET-xxxxxxxxxxxx",
  cookieName: "opennews_admin_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
  ttl: 60 * 60 * 24 * 7, // 7 days
};
