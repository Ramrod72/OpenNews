import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { hashToken } from "@/lib/auth/consumer/tokens";
import { revokeSession } from "@/lib/auth/consumer/session";

export async function POST(req: Request) {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await revokeSession(hashToken(token));
  }
  cookieStore.delete(SESSION_COOKIE_NAME);

  return NextResponse.json({ ok: true });
}
