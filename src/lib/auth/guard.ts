import { NextResponse } from "next/server";
import { CSRF_HEADER, getAdminSession, hasCsrfHeader } from "./session";

/**
 * Verifies the request is an authenticated admin, and (for mutating
 * methods) carries the same-origin CSRF header. Returns null when the
 * request may proceed, or a Response to return immediately otherwise.
 */
export async function requireAdmin(req: Request): Promise<NextResponse | null> {
  const session = await getAdminSession();
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method);
  if (mutating && !hasCsrfHeader(req)) {
    return NextResponse.json(
      { error: `Missing ${CSRF_HEADER} header on state-changing request` },
      { status: 403 },
    );
  }

  return null;
}
