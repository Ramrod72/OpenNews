import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { hashToken } from "@/lib/auth/consumer/tokens";
import { resolveSessionUser } from "@/lib/auth/consumer/session";
import { resolveViewerAdEligibility } from "@/lib/ads";

/**
 * Public, unauthenticated: tells the browser whether THIS viewer's plan
 * allows ads, so the client-side ad components (AdSlot/AdHeadSnippet) can
 * decide whether to inject anything — without any page needing to be
 * rendered per-viewer (and so without breaking the ISR caching on
 * homepage/category/story pages, none of which read cookies today; see
 * ARCHITECTURE.md for the full reasoning).
 *
 * Returns only a boolean — never the viewer's email, plan name, or any
 * other detail — since this same response shape is what a future
 * ad-provider-facing integration must never accidentally leak.
 */
export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    // No session cookie at all: definitely anonymous, no DB round trip
    // needed to know that much.
    return NextResponse.json({ adsAllowed: await resolveViewerAdEligibility(null) });
  }

  try {
    const user = await resolveSessionUser(hashToken(token));
    return NextResponse.json({ adsAllowed: await resolveViewerAdEligibility(user?.id ?? null) });
  } catch {
    // A session cookie is present but we couldn't verify who it belongs to
    // (e.g. a database outage) — this might be a paying subscriber, so
    // fail closed rather than risk showing them ads.
    return NextResponse.json({ adsAllowed: false });
  }
}
