import { z } from "zod";

/**
 * Closed sets of allowed values for Source.sourceType and
 * ExternalAssessment.assessmentType — plain strings validated here at the
 * application layer, not Prisma enums (this schema avoids DB-native enums
 * everywhere for Postgres/SQLite portability; see Subscription.status for
 * the established precedent). Extending either list is a one-line change,
 * not a migration — that's the "extensible" part of this framework.
 */
export const SOURCE_TYPE_VALUES = [
  "news_organization",
  "wire_service",
  "newspaper",
  "broadcast",
  "digital_native",
  "government",
  "official_institution",
  "academic_research",
  "trade_publication",
  "blog",
  "other",
] as const;

export type SourceType = (typeof SOURCE_TYPE_VALUES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  news_organization: "News organization",
  wire_service: "Wire service",
  newspaper: "Newspaper",
  broadcast: "Broadcast",
  digital_native: "Digital-native",
  government: "Government",
  official_institution: "Official institution",
  academic_research: "Academic / research",
  trade_publication: "Trade publication",
  blog: "Blog",
  other: "Other",
};

export const ASSESSMENT_TYPE_VALUES = [
  "political_lean",
  "factuality",
  "credibility",
  "reliability",
  "other",
] as const;

export type AssessmentType = (typeof ASSESSMENT_TYPE_VALUES)[number];

export const ASSESSMENT_TYPE_LABELS: Record<AssessmentType, string> = {
  political_lean: "Political lean",
  factuality: "Factuality",
  credibility: "Credibility",
  reliability: "Reliability",
  other: "Other",
};

const CURRENT_YEAR = new Date().getFullYear();

/** http(s)-only URL, consistent with safeImageUrl/assertPublicHttpUrl elsewhere. */
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), { message: "Must be an http(s) URL" });

/** An optional field that treats an empty string the same as "not provided". */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined));
}

export const sourceProfileSchema = z.object({
  description: optionalText(2000),
  sourceType: z.enum(SOURCE_TYPE_VALUES).optional(),
  country: optionalText(100),
  ownership: optionalText(300),
  foundedYear: z.number().int().min(1000).max(CURRENT_YEAR).optional(),
  homepageUrl: httpUrl
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  logoUrl: httpUrl
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
});

export type SourceProfileInput = z.infer<typeof sourceProfileSchema>;

export const externalAssessmentSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  assessmentType: z.enum(ASSESSMENT_TYPE_VALUES),
  ratingValue: z.string().trim().min(1).max(200),
  ratingScale: optionalText(300),
  referenceUrl: httpUrl
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  assessedAt: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "Invalid date",
    }),
  notes: optionalText(1000),
});

export type ExternalAssessmentInput = z.infer<typeof externalAssessmentSchema>;
