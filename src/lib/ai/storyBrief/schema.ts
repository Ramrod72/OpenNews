import { findForbiddenLanguage } from "./languagePolicy";

/**
 * Phase 11B's grounded output contract and full validation pipeline.
 * `validateAiStoryBriefOutput` is the ONE gate between a provider's raw
 * text and anything ever persisted or rendered — every check below is
 * independent of which AIProvider produced the text (see provider.ts),
 * and every check fails CLOSED: the first failing step rejects the whole
 * output, never a partial render (see storyBrief/generate.ts's own
 * "at most one regeneration attempt, then fail closed" policy).
 */

export const MAX_SUMMARY_CHARS = 400;
export const MAX_ITEM_CHARS = 200;
export const MAX_ARRAY_ITEMS = 10;
/** Hard ceiling on the raw provider response text length, checked before even attempting JSON.parse. */
export const MAX_RAW_OUTPUT_CHARS = 4000;
/** Ceiling on the final constructed (server-limitations-included) output, serialized. */
export const MAX_TOTAL_OUTPUT_CHARS = 1500;

export interface AiStoryBriefStatement {
  text: string;
  refs: string[];
}

export interface AiStoryBriefUnresolvedQuestion {
  text: string;
}

/** The exact shape the MODEL is asked to produce — no `limitations` field: that's always server-templated (see appendServerLimitations), never trusted from the model. */
export interface AiStoryBriefModelOutput {
  summary: AiStoryBriefStatement;
  commonAssertions: AiStoryBriefStatement[];
  coverageDifferences: AiStoryBriefStatement[];
  sourceOverlapNotes: AiStoryBriefStatement[];
  unresolvedQuestions: AiStoryBriefUnresolvedQuestion[];
}

/** The final shape ever persisted/rendered — model output plus server-templated limitations. */
export interface AiStoryBriefOutput extends AiStoryBriefModelOutput {
  limitations: string[];
}

export type ValidationFailureReason =
  | "invalid_json"
  | "schema_mismatch"
  | "unknown_field"
  | "field_too_long"
  | "array_too_long"
  | "missing_refs"
  | "unsupported_reference"
  | "forbidden_language"
  | "oversized_response"
  | "unsupported_url";

export interface ValidationSuccess {
  ok: true;
  output: AiStoryBriefModelOutput;
}

export interface ValidationFailure {
  ok: false;
  reason: ValidationFailureReason;
  detail?: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

const MODEL_TOP_LEVEL_FIELDS = new Set([
  "summary",
  "commonAssertions",
  "coverageDifferences",
  "sourceOverlapNotes",
  "unresolvedQuestions",
]);
const STATEMENT_FIELDS = new Set(["text", "refs"]);
const UNRESOLVED_FIELDS = new Set(["text"]);

// An explicit scheme list, not a generic "word:non-space" pattern: the
// model has no legitimate reason to emit ANY URL (every real link on this
// page already comes from server-constructed, safeHttpUrl-sanitized data,
// never from the AI), but a fully generic scheme-shaped pattern would
// false-positive on ordinary prose like "Note:the story continues"
// (some models omit the space after a colon). Matches WITH or WITHOUT
// "//" — a bare "javascript:" or "data:" URI has no "//" at all, so
// requiring it would miss exactly the schemes most worth catching.
const URL_LIKE_PATTERN = /\b(?:https?|ftp|file|javascript|data|vbscript|mailto|tel):\S/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStatement(
  value: unknown,
  validRefs: ReadonlySet<string>,
  requireRefs: boolean,
  maxTextChars: number,
): ValidationFailure | AiStoryBriefStatement {
  if (!isPlainObject(value)) return { ok: false, reason: "schema_mismatch" };
  for (const key of Object.keys(value)) {
    if (!STATEMENT_FIELDS.has(key)) return { ok: false, reason: "unknown_field", detail: key };
  }
  const text = value.text;
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, reason: "schema_mismatch", detail: "text" };
  }
  if (text.length > maxTextChars) return { ok: false, reason: "field_too_long", detail: "text" };
  if (URL_LIKE_PATTERN.test(text)) return { ok: false, reason: "unsupported_url" };
  const forbidden = findForbiddenLanguage(text);
  if (forbidden) return { ok: false, reason: "forbidden_language", detail: forbidden };

  const refsValue = value.refs;
  if (!Array.isArray(refsValue) || !refsValue.every((r) => typeof r === "string")) {
    return { ok: false, reason: "schema_mismatch", detail: "refs" };
  }
  const refs = refsValue as string[];
  if (requireRefs && refs.length === 0) {
    return { ok: false, reason: "missing_refs" };
  }
  for (const ref of refs) {
    if (!validRefs.has(ref)) return { ok: false, reason: "unsupported_reference", detail: ref };
  }
  return { text, refs };
}

function validateStatementArray(
  value: unknown,
  validRefs: ReadonlySet<string>,
): ValidationFailure | AiStoryBriefStatement[] {
  if (!Array.isArray(value)) return { ok: false, reason: "schema_mismatch" };
  if (value.length > MAX_ARRAY_ITEMS) return { ok: false, reason: "array_too_long" };
  const items: AiStoryBriefStatement[] = [];
  for (const raw of value) {
    const result = validateStatement(raw, validRefs, /* requireRefs */ true, MAX_ITEM_CHARS);
    if ("ok" in result && result.ok === false) return result;
    items.push(result as AiStoryBriefStatement);
  }
  return items;
}

function validateUnresolvedArray(
  value: unknown,
): ValidationFailure | AiStoryBriefUnresolvedQuestion[] {
  if (!Array.isArray(value)) return { ok: false, reason: "schema_mismatch" };
  if (value.length > MAX_ARRAY_ITEMS) return { ok: false, reason: "array_too_long" };
  const items: AiStoryBriefUnresolvedQuestion[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) return { ok: false, reason: "schema_mismatch" };
    for (const key of Object.keys(raw)) {
      if (!UNRESOLVED_FIELDS.has(key)) return { ok: false, reason: "unknown_field", detail: key };
    }
    const text = raw.text;
    if (typeof text !== "string" || text.length === 0) {
      return { ok: false, reason: "schema_mismatch", detail: "text" };
    }
    if (text.length > MAX_ITEM_CHARS)
      return { ok: false, reason: "field_too_long", detail: "text" };
    if (URL_LIKE_PATTERN.test(text)) return { ok: false, reason: "unsupported_url" };
    const forbidden = findForbiddenLanguage(text);
    if (forbidden) return { ok: false, reason: "forbidden_language", detail: forbidden };
    items.push({ text });
  }
  return items;
}

/**
 * Validates a provider's raw text against the exact Phase 11B contract.
 * `validRefs` MUST be the server-constructed reference set for the SAME
 * request (see input.ts's collectValidReferences) — a ref is accepted
 * only because it exists in that set, never merely because it matches the
 * `WORD-GROUP-N` string shape (see this module's own doc comment).
 */
export function validateAiStoryBriefOutput(
  raw: string,
  validRefs: ReadonlySet<string>,
): ValidationResult {
  if (raw.length > MAX_RAW_OUTPUT_CHARS) {
    return { ok: false, reason: "oversized_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!isPlainObject(parsed)) return { ok: false, reason: "schema_mismatch" };
  for (const key of Object.keys(parsed)) {
    if (!MODEL_TOP_LEVEL_FIELDS.has(key)) {
      return { ok: false, reason: "unknown_field", detail: key };
    }
  }

  const summaryResult = validateStatement(
    parsed.summary,
    validRefs,
    /* requireRefs */ true,
    MAX_SUMMARY_CHARS,
  );
  if ("reason" in summaryResult) return summaryResult;

  const commonAssertions = validateStatementArray(parsed.commonAssertions, validRefs);
  if ("reason" in commonAssertions) return commonAssertions;

  const coverageDifferences = validateStatementArray(parsed.coverageDifferences, validRefs);
  if ("reason" in coverageDifferences) return coverageDifferences;

  const sourceOverlapNotes = validateStatementArray(parsed.sourceOverlapNotes, validRefs);
  if ("reason" in sourceOverlapNotes) return sourceOverlapNotes;

  const unresolvedQuestions = validateUnresolvedArray(parsed.unresolvedQuestions);
  if ("reason" in unresolvedQuestions) return unresolvedQuestions;

  return {
    ok: true,
    output: {
      summary: summaryResult,
      commonAssertions,
      coverageDifferences,
      sourceOverlapNotes,
      unresolvedQuestions,
    },
  };
}

/**
 * Appends the server-templated (never model-generated) limitations
 * footer, forming the final persisted/rendered output. `limitationsNote`
 * is Phase 10's own existing fixed disclosure string, reused verbatim for
 * consistency rather than writing a second, slightly-different one.
 */
export function appendServerLimitations(
  modelOutput: AiStoryBriefModelOutput,
  limitationsNote: string,
): AiStoryBriefOutput {
  return {
    ...modelOutput,
    limitations: [
      limitationsNote,
      "This brief was generated by AI from Veriqen's own structured claim and coverage data for this story — it did not read the full articles.",
      "It does not determine what actually happened, and repetition across articles is never treated as independent confirmation.",
    ],
  };
}

export function totalOutputChars(output: AiStoryBriefOutput): number {
  return JSON.stringify(output).length;
}
