import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/lib/auth/consumer/sessionOptions";
import { hashToken } from "@/lib/auth/consumer/tokens";
import { resolveSessionUser } from "@/lib/auth/consumer/session";
import { getAdSettings, resolveViewerAdEligibility } from "@/lib/ads";

/**
 * Public, unauthenticated: tells the browser whether THIS viewer's plan
 * allows ads, so the client-side ad components (AdSlot/AdHeadSnippet) can
 * decide whether to inject anything — without any page needing to be
 * rendered per-viewer (and so without breaking the ISR caching on
 * homepage/category/story pages, none of which read cookies today; see
 * ARCHITECTURE.md for the full reasoning).
 *
 * The actual ad configuration (`settings` — every slot's code, the head
 * loader snippet) is included ONLY when `adsAllowed` is true. This isn't
 * just about not *rendering* it for an ineligible viewer: the ad
 * network's snippet/script text must never even reach a Basic/Pro
 * browser over the network, so it can't sit inertly in that viewer's page
 * regardless of whether anything ever executes it. When `adsAllowed` is
 * false, this response is `{ adsAllowed: false }` and nothing else —
 * never email, user id, plan name, or any ad configuration.
 */
async function buildResponse(userId: string | null) {
  const adsAllowed = await resolveViewerAdEligibility(userId);
  if (!adsAllowed) {
    return NextResponse.json({ adsAllowed: false });
  }
  return NextResponse.json({ adsAllowed: true, settings: await getAdSettings() });
}

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    // No session cookie at all: definitely anonymous, no DB round trip
    // needed to know that much.
    return buildResponse(null);
  }

  try {
    const user = await resolveSessionUser(hashToken(token));
    return buildResponse(user?.id ?? null);
  } catch {
    // A session cookie is present but we couldn't verify who it belongs to
    // (e.g. a database outage) — this might be a paying subscriber, so
    // fail closed rather than risk showing (or sending) them ads.
    return NextResponse.json({ adsAllowed: false });
  }
}
