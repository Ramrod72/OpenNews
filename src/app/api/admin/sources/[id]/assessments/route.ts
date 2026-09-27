import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { toPlainText } from "@/lib/security/sanitize";
import { externalAssessmentSchema } from "@/lib/validation/sourceProfile";

/** Create a new external assessment for a source. Provider/rating/scale/notes are stored as plain text, never HTML. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id: sourceId } = await params;
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  const parsed = externalAssessmentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const assessment = await prisma.externalAssessment.create({
    data: {
      sourceId,
      provider: toPlainText(data.provider, 200),
      assessmentType: data.assessmentType,
      ratingValue: toPlainText(data.ratingValue, 200),
      ratingScale: data.ratingScale ? toPlainText(data.ratingScale, 300) : null,
      referenceUrl: data.referenceUrl ?? null,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : null,
      notes: data.notes ? toPlainText(data.notes, 1000) : null,
    },
  });

  return NextResponse.json({ assessment }, { status: 201 });
}
