import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminPassword } from "@/lib/auth/password";
import { getAdminSession } from "@/lib/auth/session";
import { clientIp, isRateLimited } from "@/lib/rateLimit";
import { isGlobalAdminLoginRateLimited } from "@/lib/adminLoginRateLimit";

const bodySchema = z.object({ password: z.string().min(1).max(500) });

export async function POST(req: Request) {
  const ip = clientIp(req);
  // Both checks always run (never short-circuited) so each bucket's own
  // state stays accurate regardless of which one trips first — see
  // adminLoginRateLimit.ts's own doc comment for why a second,
  // process-global budget exists alongside this per-IP one. Both paths
  // return the exact same response, so a caller can never tell WHICH
  // limiter it hit.
  const ipLimited = isRateLimited(`admin-login:${ip}`, 10, 5 * 60 * 1000);
  const globalLimited = isGlobalAdminLoginRateLimited();
  if (ipLimited || globalLimited) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const valid = await verifyAdminPassword(parsed.data.password);
  if (!valid) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const session = await getAdminSession();
  session.isAdmin = true;
  await session.save();

  return NextResponse.json({ ok: true });
}
