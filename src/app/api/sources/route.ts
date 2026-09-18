import { NextResponse } from "next/server";
import { listActiveSources } from "@/lib/stories";

export async function GET() {
  const sources = await listActiveSources();
  return NextResponse.json({ sources });
}
