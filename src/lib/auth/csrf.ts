/**
 * Split out from session.ts (which imports next/headers) so client
 * components can safely import just the header name without pulling in
 * server-only APIs.
 */
export const CSRF_HEADER = "x-opennews-admin";

export function hasCsrfHeader(req: Request): boolean {
  return req.headers.get(CSRF_HEADER) === "1";
}
