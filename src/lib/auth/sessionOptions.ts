import type { SessionOptions } from "iron-session";

export interface AdminSessionData {
  isAdmin?: boolean;
}

// iron-session itself refuses to seal/unseal with a password shorter than
// this (see iron-session's own internal validation) — checked here too so
// misconfiguration fails with a clear, non-secret-revealing message instead
// of a rejected promise from deep inside the library.
const MIN_SESSION_SECRET_LENGTH = 32;

// Used ONLY outside production, so a fresh local/dev/test checkout works
// with no configuration. This value is public (it lives in this
// open-source repository), so it must be structurally impossible for it to
// ever sign a real production admin session — see getSessionOptions()
// below, which throws instead of ever returning this value when
// NODE_ENV === "production".
const DEV_ONLY_FALLBACK_SECRET = "dev-only-insecure-secret-please-set-SESSION_SECRET-xxxxxxxxxxxx";

function isValidSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_SESSION_SECRET_LENGTH;
}

// Loud, log-only, non-fatal signal at first import so an operator sees this
// in their process/container logs immediately at boot, without crashing
// unrelated (non-admin) traffic just because the admin secret happens to be
// misconfigured. The actual enforcement — refusing to create or read any
// admin session at all — happens lazily in getSessionOptions() below,
// which every real admin request goes through (src/proxy.ts's guardAdmin()
// and src/lib/auth/session.ts's getAdminSession()).
if (process.env.NODE_ENV === "production" && !isValidSecret(process.env.SESSION_SECRET)) {
  console.error(
    "[auth] SESSION_SECRET is missing or shorter than 32 characters in production. " +
      "Admin login and every /admin route will fail closed (return an error response) " +
      "until a real secret is configured — see .env.example. Generate one with " +
      "`openssl rand -base64 32`.",
  );
}

/**
 * Builds the iron-session config for the admin session cookie, validating
 * the signing secret first.
 *
 * In production, a missing, empty, or too-short SESSION_SECRET throws
 * rather than silently falling back to any hardcoded value: it must be
 * structurally impossible for the well-known development fallback secret
 * (visible in this public repository) to ever sign a real production admin
 * session. This throws on every call while misconfigured, so admin
 * authentication fails closed for as long as the condition holds — there
 * is no window where a first "successful" call could have already handed
 * out a session sealed with a fallback secret.
 *
 * Outside production, a missing/short secret uses DEV_ONLY_FALLBACK_SECRET
 * so local development and tests need no configuration — this is the one
 * intentionally developer-friendly behavior the spec allows.
 *
 * Called lazily (per request) rather than validated once at module load,
 * so a misconfigured SESSION_SECRET fails closed only for the admin
 * surface — it never takes down unrelated public routes that happen to
 * share this middleware bundle.
 */
export function getSessionOptions(): SessionOptions {
  const secret = process.env.SESSION_SECRET;
  let password: string;

  if (process.env.NODE_ENV === "production") {
    if (!isValidSecret(secret)) {
      throw new Error(
        "SESSION_SECRET is missing or shorter than 32 characters in production. Admin " +
          "sessions cannot be created or verified until a real secret is configured " +
          "(see .env.example).",
      );
    }
    password = secret;
  } else {
    password = isValidSecret(secret) ? secret : DEV_ONLY_FALLBACK_SECRET;
  }

  return {
    password,
    cookieName: "opennews_admin_session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
    ttl: 60 * 60 * 24 * 7, // 7 days
  };
}
