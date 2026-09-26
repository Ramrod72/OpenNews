import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getPlan } from "@/lib/entitlements";

/** The current session's account, plan, and entitlements. 401 if not logged in. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const plan = await getPlan(user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
    },
    plan,
  });
}
