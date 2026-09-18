import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "unknown" },
      { status: 503 },
    );
  }
}
