import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { getSessionOptions, type AdminSessionData } from "@/lib/auth/sessionOptions";
import { clientIp, isRateLimited } from "@/lib/rateLimit";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { hashToken } from "@/lib/auth/consumer/tokens";
import { resolveSessionUser } from "@/lib/auth/consumer/session";

const API_RATE_LIMIT = 120; // requests
const API_RATE_WINDOW_MS = 60_000; // per minute, per IP

// The story page is the single most expensive page render in the app —
// per-cluster graph/claim-grouping computation (loadStoryIntelligence,
// loadCoverageComparison) plus a possible AI Story Brief call, all
// unconditionally recomputed on every request (see ARCHITECTURE.md's
// Phase 14B note on why full response caching isn't a safe drop-in fix
// here — entitlement redaction must stay per-viewer). It has no API route
// of its own to attach a limiter to (it's a server component), so this is
// enforced at the same middleware layer as the general /api/* limiter
// above, before the page ever renders. Generous relative to a real reader
// (Next.js Link prefetching on a category/homepage grid can trigger a
// short burst of story-page loads for one visitor) while still bounding a
// scripted flood to a fixed, low multiple of that.
const STORY_PAGE_RATE_LIMIT = 100;
const STORY_PAGE_RATE_WINDOW_MS = 60_000;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    const ip = clientIp(request);
    if (isRateLimited(`api:${ip}`, API_RATE_LIMIT, API_RATE_WINDOW_MS)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
  }

  if (pathname.startsWith("/story/")) {
    const ip = clientIp(request);
    if (isRateLimited(`story-page:${ip}`, STORY_PAGE_RATE_LIMIT, STORY_PAGE_RATE_WINDOW_MS)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
  }

  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    return guardAdmin(request);
  }

  if (pathname.startsWith("/account")) {
    return guardAccount(request);
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

  let sessionOptions;
  try {
    sessionOptions = getSessionOptions();
  } catch {
    // SESSION_SECRET is missing/invalid in production: fail closed. No
    // admin session can be created or verified in this state, so there is
    // nothing to redirect to a login page that couldn't work either — the
    // response body never includes the underlying error (which never
    // contains the secret anyway, but stays generic regardless).
    return NextResponse.json({ error: "Admin authentication is unavailable." }, { status: 500 });
  }

  const session = await getIronSession<AdminSessionData>(request, response, sessionOptions);

  if (!session.isAdmin) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  return response;
}

/**
 * Gates the /account UI the same way guardAdmin() gates /admin, and for the
 * same reason: a redirect() thrown from inside the page component can't
 * change the HTTP status once the surrounding layout has already started
 * streaming a 200 response, so it degrades to a client-side/meta-refresh
 * redirect instead of a real 3xx. That's still safe (no account data is
 * ever rendered before the throw), but middleware lets an anonymous
 * request get a real 307 to /login instead of a 200. The page itself keeps
 * its own redirect() as defense in depth.
 */
async function guardAccount(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const user = token ? await resolveSessionUser(hashToken(token)) : null;

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/:path*", "/account/:path*", "/story/:path*"],
};
