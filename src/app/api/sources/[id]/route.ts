import { NextResponse } from "next/server";
import { getSourceProfile, toPublicSourceProfile } from "@/lib/sourceProfile";

/**
 * Public, unauthenticated: a source's profile metadata plus every external
 * assessment on file, each carrying its own provider attribution. No
 * auth required — the source list and every field returned here are
 * already public via /sources and /api/sources; this just adds the
 * profile detail for one source id. 404 for an unknown id; a merely
 * paused (inactive) source's profile still resolves (see getSourceProfile).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = await getSourceProfile(id);
  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
  return NextResponse.json(toPublicSourceProfile(source));
}
