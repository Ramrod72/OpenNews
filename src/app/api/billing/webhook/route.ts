import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRuntimeBilling } from "@/lib/billing/runtimeProvider";
import { processWebhookEvent } from "@/lib/billing/webhookSync";
import { MAX_WEBHOOK_BODY_CHARS } from "@/lib/billing/stripeProvider";

/**
 * Stripe's webhook endpoint — the highest-risk trust boundary in Phase
 * 12B. Every request here is treated as hostile until its signature is
 * verified against the RAW, byte-exact request body; nothing about the
 * payload is trusted, parsed further, or logged before that check passes.
 *
 * Reads the body with a bounded reader (mirroring Phase 11B's own
 * readBodyWithLimit precedent for exactly this reason: a webhook body
 * this large is never a legitimate Stripe event, and buffering an
 * attacker-supplied arbitrarily large body into memory before checking
 * its size is itself a denial-of-service vector) BEFORE ever calling
 * `.text()`/`.json()`, which would otherwise buffer an unbounded amount
 * unconditionally.
 */
export async function POST(req: Request) {
  const rawBody = await readBodyWithLimit(req, MAX_WEBHOOK_BODY_CHARS);
  if (rawBody === null) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const billing = getRuntimeBilling();
  if (!billing.enabled) {
    // Billing isn't configured on this deployment at all — nothing to
    // verify against. Not a Stripe-retryable situation (retrying won't
    // configure the server), so acknowledge and drop rather than looping.
    console.error("[billing-webhook] received a webhook request but billing is not configured");
    return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });
  }

  const signatureHeader = req.headers.get("stripe-signature");
  const verified = billing.provider.verifyWebhookEvent(rawBody, signatureHeader);
  if (!verified.ok) {
    // No payload content is ever logged here — a failed signature means
    // the body is not yet trusted enough to appear in a log line (see
    // SECURITY.md's webhook section).
    console.error(`[billing-webhook] rejected: ${verified.reason}`);
    return NextResponse.json({ error: "Invalid webhook request." }, { status: 400 });
  }

  try {
    const outcome = await processWebhookEvent(prisma, billing.provider, billing.config, verified);
    switch (outcome.outcome) {
      case "processed":
      case "duplicate":
      case "ignored_event_type":
      case "unknown_customer":
      case "unknown_price":
      case "duplicate_subscription_conflict":
        // Acknowledged (2xx) in every case — none of these are something
        // a Stripe retry could ever resolve. duplicate_subscription_conflict
        // in particular is already logged loudly inside webhookSync.ts and
        // requires human reconciliation, not a repeated delivery.
        return NextResponse.json({ received: true });
      case "retryable_failure":
        // Deliberately a 500, not a 2xx: the event is NOT marked
        // processed (see webhookSync.ts's own atomicity guarantee), so
        // Stripe must retry this exact event again later.
        console.error(
          `[billing-webhook] retryable failure for event ${verified.eventId}: ${outcome.reason}`,
        );
        return NextResponse.json({ error: "Temporary failure, please retry." }, { status: 500 });
    }
  } catch (err) {
    console.error(`[billing-webhook] unexpected error processing event ${verified.eventId}:`, err);
    return NextResponse.json({ error: "Temporary failure, please retry." }, { status: 500 });
  }
}

/**
 * Reads a request body up to `limitChars` characters, aborting and
 * returning null if the body is larger — mirrors
 * src/lib/ai/storyBrief/ollamaProvider.ts's readBodyWithLimit, applied
 * here to an incoming Request instead of a provider Response.
 */
async function readBodyWithLimit(req: Request, limitChars: number): Promise<string | null> {
  if (!req.body) {
    const text = await req.text();
    return text.length > limitChars ? null : text;
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      text += decoder.decode(value, { stream: true });
      if (text.length > limitChars) {
        await reader.cancel();
        return null;
      }
    }
  }

  return text;
}
