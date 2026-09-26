import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { registerSchema } from "@/lib/validation/account";
import { registerUser } from "@/lib/auth/consumer/service";
import { hasCsrfHeader, CSRF_HEADER } from "@/lib/auth/consumer/csrf";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth/consumer/sessionOptions";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

export async function POST(req: Request) {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
  }

  const ip = clientIp(req);
  if (isRateLimited(`account-register:${ip}`, 5, 15 * 60 * 1000)) {
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
