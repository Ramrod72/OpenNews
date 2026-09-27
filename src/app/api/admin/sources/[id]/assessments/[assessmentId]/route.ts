import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/guard";
import { toPlainText } from "@/lib/security/sanitize";
import { externalAssessmentSchema } from "@/lib/validation/sourceProfile";

/**
 * Assessments are edited wholesale (PUT-like semantics via PATCH, matching
 * the create schema) rather than field-by-field, since a partial edit of
 * an attributed rating is more likely to produce an inconsistent record
 * than a small win in convenience — the admin form always submits the
 * full assessment anyway.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; assessmentId: string }> },
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id: sourceId, assessmentId } = await params;
  const parsed = externalAssessmentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const existing = await prisma.externalAssessment.findFirst({
    where: { id: assessmentId, sourceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  }

  const assessment = await prisma.externalAssessment.update({
    where: { id: assessmentId },
    data: {
      provider: toPlainText(data.provider, 200),
      assessmentType: data.assessmentType,
      ratingValue: toPlainText(data.ratingValue, 200),
      ratingScale: data.ratingScale ? toPlainText(data.ratingScale, 300) : null,
      referenceUrl: data.referenceUrl ?? null,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : null,
      notes: data.notes ? toPlainText(data.notes, 1000) : null,
    },
  });

  return NextResponse.json({ assessment });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; assessmentId: string }> },
) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id: sourceId, assessmentId } = await params;
  const existing = await prisma.externalAssessment.findFirst({
    where: { id: assessmentId, sourceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  }

  await prisma.externalAssessment.delete({ where: { id: assessmentId } });
  return NextResponse.json({ ok: true });
}
