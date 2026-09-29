import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { clientIp, isRateLimited } from "@/lib/rateLimit";
import { getRuntimeBilling } from "@/lib/billing/runtimeProvider";
import { createCheckoutForUser } from "@/lib/billing/checkout";

/**
 * Starts a first-purchase Stripe Checkout for the CURRENT authenticated
 * user. Identity comes only from the session (getCurrentUser()) — the
 * request body carries only a closed plan slug, never a userId, email,
 * customerId, priceId, or anything else billing-identity-bearing (see
 * checkout.ts's own doc comment for the full trust-boundary rationale).
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
    isRateLimited(`billing-checkout:${user.id}`, 5, 60_000) ||
    isRateLimited(`billing-checkout-ip:${ip}`, 20, 60_000)
  ) {
    return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const billing = getRuntimeBilling();
  if (!billing.enabled) {
    return NextResponse.json({ error: "Billing is not available right now." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const plan =
    body && typeof body === "object" ? (body as Record<string, unknown>).plan : undefined;

  const result = await createCheckoutForUser(prisma, billing.provider, billing.config, {
    userId: user.id,
    userEmail: user.email,
    plan,
  });

  switch (result.status) {
    case "ok":
      return NextResponse.json({ url: result.url });
    case "invalid_plan":
      return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
    case "already_subscribed":
      return NextResponse.json(
        {
          error:
            "You already have an active paid subscription. Use Manage Billing to change plans.",
        },
        { status: 409 },
      );
    case "checkout_in_progress":
      return NextResponse.json(
        { error: "A checkout attempt is already in progress. Please wait or try again shortly." },
        { status: 409 },
      );
    case "unavailable":
      return NextResponse.json({ error: "Checkout is temporarily unavailable." }, { status: 503 });
  }
}
