/**
 * Same lightweight CSRF defense as the admin panel (src/lib/auth/csrf.ts),
 * but with its own header name — consumer and admin auth are kept
 * completely independent, including this mechanism, so nothing here is
 * shared code with the admin CSRF module.
 */
export const CSRF_HEADER = "x-veriqen-account";

export function hasCsrfHeader(req: Request): boolean {
  return req.headers.get(CSRF_HEADER) === "1";
}
