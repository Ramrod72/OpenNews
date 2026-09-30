import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    // This is public and unauthenticated (it's a healthcheck endpoint), so
    // the raw exception is logged server-side only — it can carry driver
    // error text (hostnames, ports, connection-string fragments) that must
    // never reach an unauthenticated caller. See test/healthEndpointDisclosure.test.ts.
    console.error("[health] readiness check failed:", err);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
