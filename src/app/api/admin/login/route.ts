import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminPassword } from "@/lib/auth/password";
import { getAdminSession } from "@/lib/auth/session";
import { clientIp, isRateLimited } from "@/lib/rateLimit";

const bodySchema = z.object({ password: z.string().min(1).max(500) });

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (isRateLimited(`admin-login:${ip}`, 10, 5 * 60 * 1000)) {
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
