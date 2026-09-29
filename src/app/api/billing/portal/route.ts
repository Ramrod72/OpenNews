import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { clientIp, isRateLimited } from "@/lib/rateLimit";
import { getRuntimeBilling } from "@/lib/billing/runtimeProvider";
import { createPortalForUser } from "@/lib/billing/portal";

/**
 * Creates a Stripe Customer Portal session for the CURRENT authenticated
 * user only — the customer id is read from that user's own DB row inside
 * createPortalForUser, never from the request (there is no request body
 * this endpoint even reads).
 */
export async function POST(req: Request) {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const ip = clientIp(req);
  if (
    isRateLimited(`billing-portal:${user.id}`, 10, 60_000) ||
    isRateLimited(`billing-portal-ip:${ip}`, 30, 60_000)
  ) {
    return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const billing = getRuntimeBilling();
  if (!billing.enabled) {
    return NextResponse.json({ error: "Billing is not available right now." }, { status: 503 });
  }

  const result = await createPortalForUser(prisma, billing.provider, { userId: user.id });

  switch (result.status) {
    case "ok":
      return NextResponse.json({ url: result.url });
    case "no_customer":
      return NextResponse.json({ error: "No billing account yet." }, { status: 400 });
    case "unavailable":
      return NextResponse.json(
        { error: "Billing portal is temporarily unavailable." },
        { status: 503 },
      );
  }
}
