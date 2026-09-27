import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { toPlainText } from "@/lib/security/sanitize";
import { SOURCE_TYPE_VALUES } from "@/lib/validation/sourceProfile";

const PROFILE_FIELDS = [
  "description",
  "sourceType",
  "country",
  "ownership",
  "foundedYear",
] as const;

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  homepageUrl: z.string().url().optional().or(z.literal("")).optional(),
  categorySlug: z.string().min(1).optional(),
  fetchIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  active: z.boolean().optional(),
  // Phase 6: source-profile metadata. All optional — a source with only
  // the fields above continues to work exactly as before.
  logoUrl: z.string().url().optional().or(z.literal("")).optional(),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  sourceType: z.enum(SOURCE_TYPE_VALUES).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  ownership: z.string().trim().max(300).optional().or(z.literal("")),
  foundedYear: z.number().int().min(1000).max(new Date().getFullYear()).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.categorySlug) {
    const category = await prisma.category.findUnique({
      where: { slug: parsed.data.categorySlug },
    });
    if (!category) return NextResponse.json({ error: "Unknown category slug" }, { status: 400 });
  }

  const { logoUrl, description, sourceType, country, ownership, foundedYear, ...rest } =
    parsed.data;
  const touchedProfileField = PROFILE_FIELDS.some((f) => f in parsed.data);

  try {
    const source = await prisma.source.update({
      where: { id },
      data: {
        ...rest,
        homepageUrl: parsed.data.homepageUrl === "" ? null : parsed.data.homepageUrl,
        ...(logoUrl !== undefined && { logoUrl: logoUrl === "" ? null : logoUrl }),
        // Free text stored as plain text only — never raw HTML, regardless
        // of what an admin pastes in (defense in depth; React's rendering
        // already never uses dangerouslySetInnerHTML for these fields).
        ...(description !== undefined && {
          description: description ? toPlainText(description, 2000) : null,
        }),
        ...(sourceType !== undefined && { sourceType: sourceType || null }),
        ...(country !== undefined && { country: country ? toPlainText(country, 100) : null }),
        ...(ownership !== undefined && {
          ownership: ownership ? toPlainText(ownership, 300) : null,
        }),
        ...(foundedYear !== undefined && { foundedYear }),
        ...(touchedProfileField && { profileUpdatedAt: new Date() }),
      },
    });
    return NextResponse.json({ source });
  } catch {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    await prisma.source.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
}
