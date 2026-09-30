import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { registerSchema } from "@/lib/validation/account";
import { registerUser } from "@/lib/auth/consumer/service";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth/consumer/sessionOptions";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

// Registration has no secondary per-target key available before an account
// exists (unlike login, which also keys off the target email), so an
// attacker who spoofs/rotates their client IP on every request would
// otherwise defeat the per-IP bucket below entirely. This process-global
// bucket is a deliberately generous backstop -- high enough to never
// trouble a real signup burst, low enough to bound runaway scripted
// account creation -- mirroring the admin-login global limiter's role in
// src/lib/adminLoginRateLimit.ts.
const REGISTER_GLOBAL_LIMIT = 50;
const REGISTER_GLOBAL_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
  }

  const ip = clientIp(req);
  // Both checks always run (never short-circuited) so each bucket's own
  // state stays accurate regardless of which one trips first -- see
  // src/app/api/admin/login/route.ts for the same pattern.
  const ipLimited = isRateLimited(`account-register:${ip}`, 5, 15 * 60 * 1000);
  const globalLimited = isRateLimited(
    "account-register:global",
    REGISTER_GLOBAL_LIMIT,
    REGISTER_GLOBAL_WINDOW_MS,
  );
  if (ipLimited || globalLimited) {
    return NextResponse.json(
      { error: "Too many sign-up attempts. Try again later." },
      { status: 429 },
    );
  }

  const parsed = registerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await registerUser(parsed.data, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: ip,
  });

  if ("error" in result) {
    const status = result.error.includes("already exists") ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, result.token, SESSION_COOKIE_OPTIONS);

  return NextResponse.json({ user: result.user }, { status: 201 });
}
