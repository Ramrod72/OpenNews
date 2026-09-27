import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { httpUrl } from "@/lib/validation/sourceProfile";

// Both url and homepageUrl are rendered as real clickable links in the
// admin sources list (the feed-URL external-link icon and the homepage
// link respectively), so a bare z.string().url() here would accept
// javascript:/data:/file: schemes and credentialed/deceptive URLs — the
// same click-triggered vector fixed elsewhere in Phase 6's own routes.
// httpUrl (already used by the Phase 6 profile/assessment schemas)
// restricts both to plain http(s) with no embedded userinfo. This isn't a
// behavior change for a legitimate feed url: ingestion's own SSRF guard
// (assertPublicHttpUrl) already refuses anything but http(s) before ever
// fetching it — this just surfaces that same rule as a clear 400 at
// creation time instead of a later fetch failure.
const createSchema = z.object({
  name: z.string().min(1).max(200),
  url: httpUrl,
  homepageUrl: httpUrl.optional().or(z.literal("")),
  categorySlug: z.string().min(1),
  fetchIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const sources = await prisma.source.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { articles: true } } },
  });
  return NextResponse.json({ sources });
}

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const category = await prisma.category.findUnique({ where: { slug: parsed.data.categorySlug } });
  if (!category) {
    return NextResponse.json({ error: "Unknown category slug" }, { status: 400 });
  }

  try {
    const source = await prisma.source.create({
      data: {
        name: parsed.data.name,
        url: parsed.data.url,
        homepageUrl: parsed.data.homepageUrl || null,
        categorySlug: parsed.data.categorySlug,
        fetchIntervalMinutes: parsed.data.fetchIntervalMinutes ?? 30,
      },
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return NextResponse.json(
        { error: "A source with this feed URL already exists" },
        { status: 409 },
      );
    }
    throw err;
  }
}
