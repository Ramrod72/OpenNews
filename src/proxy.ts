import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type AdminSessionData } from "@/lib/auth/sessionOptions";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

const API_RATE_LIMIT = 120; // requests
const API_RATE_WINDOW_MS = 60_000; // per minute, per IP

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    const ip = clientIp(request);
    if (isRateLimited(`api:${ip}`, API_RATE_LIMIT, API_RATE_WINDOW_MS)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
  }

  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    return guardAdmin(request);
  }

  return NextResponse.next();
}

/**
 * Gates the /admin UI. This MUST be middleware rather than a check inside
 * the admin layout: Next.js renders a layout's `children` segment in
 * parallel with the layout itself, so a redirect() called from a layout
 * does not stop the protected page underneath it from being rendered and
 * sent to the client first — confirmed while testing this app (the
 * dashboard's real data was included in the response even though the
 * layout redirected the browser away a second later via a meta refresh).
 * Middleware runs before any page/layout code, so it can issue a real
 * HTTP redirect and the protected page is never rendered at all.
 */
async function guardAdmin(request: NextRequest) {
  const response = NextResponse.next();
  const session = await getIronSession<AdminSessionData>(request, response, sessionOptions);

  if (!session.isAdmin) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/api/:path*"],
};
