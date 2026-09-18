import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";

export async function POST() {
  const session = await getAdminSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}
