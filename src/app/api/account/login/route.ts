import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { loginSchema } from "@/lib/validation/account";
import { loginUser } from "@/lib/auth/consumer/service";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth/consumer/sessionOptions";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

export async function POST(req: Request) {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
  }

  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ip = clientIp(req);
  // Rate-limited by IP and, separately, by the target email — the second
  // limiter keeps a single account safe from brute-force even when attempts
  // are spread across many IPs (e.g. a botnet), which an IP-only limit
  // can't catch.
  if (
    isRateLimited(`account-login:${ip}`, 10, 5 * 60 * 1000) ||
    isRateLimited(`account-login-email:${parsed.data.email}`, 10, 15 * 60 * 1000)
  ) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 },
    );
  }

  const result = await loginUser(parsed.data, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: ip,
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, result.token, SESSION_COOKIE_OPTIONS);

  return NextResponse.json({ user: result.user });
}
