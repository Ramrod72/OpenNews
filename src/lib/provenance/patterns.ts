import type {
  ProvenanceConfidence,
  ProvenanceEntityType,
  ProvenanceEvidenceType,
  ProvenanceRelationshipType,
} from "@/lib/validation/provenance";

/**
 * Deterministic, dependency-free attribution-phrase pattern matching — the
 * same philosophy as src/lib/perspective.ts (trust only what the text
 * explicitly signals) and src/lib/nlp/keywords.ts (regex-based, no NLP
 * framework). No AI, no network access, no DB access: everything here is a
 * pure function of the text it's given.
 *
 * IMPORTANT — evidence vs. truth (Phase 7A/7B policy): every evidenceType
 * below describes reporting DISTANCE / evidence FORM only. A STATEMENT is
 * primary evidence that an entity SAID something — never proof the thing
 * said is true. A COURT_FILING is primary documentary material for what a
 * filing alleges — never proof the allegation is true. A STUDY_OR_DATASET
 * is the primary research source for its own findings — never proof those
 * findings are correct. Nothing in this module, or anywhere Phase 7B
 * renders/persists this data, may imply otherwise.
 */

/** A single detected attribution construction, before entity resolution/confidence-tier finalization. */
export interface AttributionCandidate {
  relationshipType: ProvenanceRelationshipType;
  evidenceType: ProvenanceEvidenceType;
  /** The extractor's own tier — may be LOW. Persistence must filter LOW out (see persistObservations.ts). */
  confidence: ProvenanceConfidence;
  /** Raw matched entity text, if this candidate names one (empty string for role-based/fixed phrases with no entity). */
  rawEntityText: string;
  /** Best-guess entity type, used only to help entity resolution / observation defaults — never persisted directly. */
  entityTypeHint: ProvenanceEntityType;
  /** True if rawEntityText must resolve against the known alias table or this candidate is discarded entirely. */
  requiresEntityResolution: boolean;
  /**
   * True if rawEntityText should be resolved for ENRICHMENT ONLY — e.g. a
   * named outlet in "in an interview with <Entity>" is kept regardless of
   * whether it resolves (the grammatical construction is itself the
   * precision guard), but resolution, when it succeeds, can still upgrade
   * the relationship (an unrelated outlet vs. a resolvable wire service —
   * see extract.ts's finalizeCandidate). Never true at the same time as
   * requiresEntityResolution.
   */
  attemptEntityResolution?: boolean;
  /** Character offsets (into the text this matcher was given) of the full attribution clause. */
  startOffset: number;
  endOffset: number;
}

const ATTRIBUTION_VERB_ALTERNATION =
  "reported|reports|report|said|stated|states|confirmed|confirms|announced|announces|wrote|writes|found|finds|told|tells";

/**
 * Exported for reuse by Phase 10B's claims module (src/lib/claims/) —
 * negation is a general-purpose precision guard, not specific to
 * attribution, and Phase 10B's numerical-assertion extraction needs the
 * exact same "did the text actually negate this?" check rather than a
 * second, potentially-drifting word list.
 */
export const NEGATION_WORDS = new Set([
  "not",
  "never",
  "no",
  "didn't",
  "didnt",
  "hadn't",
  "hadnt",
  "hasn't",
  "hasnt",
  "wasn't",
  "wasnt",
  "weren't",
  "werent",
  "doesn't",
  "doesnt",
  "don't",
  "dont",
  "isn't",
  "isnt",
  "aren't",
  "arent",
]);

const SPECULATION_WORDS = new Set([
  "may",
  "might",
  "could",
  "would",
  "expected",
  "likely",
  "allegedly",
  "reportedly",
  "supposedly",
  "rumored",
]);

/** Words a construction's "gap" (filler between an entity and its verb) is allowed to contain, checked for guard words. */
function gapWords(gap: string): string[] {
  return gap
    .toLowerCase()
    .split(/[\s']+/)
    .filter(Boolean);
}

function gapIsClean(gap: string): boolean {
  const words = gapWords(gap.replace(/’/g, "'"));
  return !words.some((w) => NEGATION_WORDS.has(w) || SPECULATION_WORDS.has(w));
}

// Capitalized-run charset: letters, internal punctuation common in org
// names/abbreviations (periods, ampersands, hyphens, apostrophes —
// including the curly apostrophe some feeds use).
const NAME_WORD = "[A-Z][A-Za-z.&'’-]*";
// A capitalized-word run needs to tolerate a single lowercase connector
// ("Department OF Justice", "Bureau OF Investigation") without treating it
// as the end of the name — "and" is deliberately excluded, since it's far
// more likely to separate two distinct entities ("Reuters and the New
// York Times") than to be part of one name.
const NAME_CONNECTOR = "(?:of|for|the)";
const NAME_CONTINUATION = `(?:\\s+(?:${NAME_CONNECTOR}\\s+)?${NAME_WORD})`;
// Lazy: used only where a required suffix (an attribution verb) forces
// correct expansion via backtracking (see findNamedEntityAttributions's
// entity+verb matcher below).
const NAME_CAPTURE = `${NAME_WORD}${NAME_CONTINUATION}{0,4}?`;
// Greedy: used everywhere else an entity name is captured with nothing
// required to follow it — a lazy quantifier with no forcing suffix would
// stop at the FIRST capitalized word ("The Guardian" -> just "The"),
// since a bare \b boundary is already satisfied there. Greedy correctly
// captures the full run of consecutive capitalized words (and connectors)
// up to the next non-matching token or punctuation.
const NAME_CAPTURE_GREEDY = `${NAME_WORD}${NAME_CONTINUATION}{0,4}`;
// Lazy ({0,3}?), not greedy: a greedy gap would happily swallow a real
// attribution verb as generic lowercase "filler" (e.g. in "AP reported
// that police said...", a greedy gap could consume "reported that police"
// as filler before ever checking "said" as the verb, mis-scoping the whole
// match). Lazy matching tries zero gap first, so the nearest verb after
// the entity is always preferred — which is also what correctly finds and
// then rejects "Reuters did not report..." (gap grows only as needed to
// reach a real verb match, and that gap is then checked for negation/
// speculation words below).
const GAP_CAPTURE = "(?:\\s+[a-z'’]+){0,3}?";

/**
 * Finds "<Entity> <verb>" and "according to <Entity>" constructions where
 * <Entity> is a capitalized phrase. Does NOT resolve the entity — that's
 * entityResolution.ts's job; a candidate whose rawEntityText fails to
 * resolve against the known alias table must be discarded entirely by the
 * caller (requiresEntityResolution: true signals this).
 */
export function findNamedEntityAttributions(text: string): AttributionCandidate[] {
  const candidates: AttributionCandidate[] = [];

  const entityVerbRe = new RegExp(
    `\\b(?<entity>${NAME_CAPTURE})(?<gap>${GAP_CAPTURE})\\s+(?<verb>${ATTRIBUTION_VERB_ALTERNATION})\\b`,
    "gd",
  );
  for (const match of text.matchAll(entityVerbRe)) {
    const indices = (match as RegExpMatchArray & { indices: Record<string, [number, number]> })
      .indices?.groups;
    if (!indices?.entity || !indices?.verb) continue;
    const gap = match.groups?.gap ?? "";
    if (!gapIsClean(gap)) continue;

    const rawEntityText = match.groups!.entity!.trim();
    if (!rawEntityText) continue;

    candidates.push({
      relationshipType: "UNKNOWN", // finalized after entity resolution (wire vs. gov vs. outlet)
      evidenceType: "REPORTING_CITATION",
      confidence: "HIGH",
      rawEntityText,
      entityTypeHint: "UNKNOWN",
      requiresEntityResolution: true,
      startOffset: indices.entity[0],
      endOffset: indices.verb[1],
    });
  }

  const accordingToRe = new RegExp(
    `\\b[Aa]ccording to (?:the |an? )?(?<entity>${NAME_CAPTURE_GREEDY})\\b`,
    "gd",
  );
  for (const match of text.matchAll(accordingToRe)) {
    const indices = (match as RegExpMatchArray & { indices: Record<string, [number, number]> })
      .indices?.groups;
    if (!indices?.entity) continue;
    const rawEntityText = match.groups!.entity!.trim();
    if (!rawEntityText) continue;

    candidates.push({
      relationshipType: "UNKNOWN",
      evidenceType: "REPORTING_CITATION",
      confidence: "HIGH",
      rawEntityText,
      entityTypeHint: "UNKNOWN",
      requiresEntityResolution: true,
      startOffset: match.index!,
      endOffset: indices.entity[1],
    });
  }

  return candidates;
}

interface FixedPhraseRule {
  pattern: RegExp;
  relationshipType: ProvenanceRelationshipType;
  evidenceType: ProvenanceEvidenceType;
  confidence: ProvenanceConfidence;
  entityTypeHint: ProvenanceEntityType;
}

// Fixed, role-based/document-based constructions — no proper-noun entity
// capture, so no alias resolution is needed; rawEntityText is just the
// recognized role/document phrase itself, and entityId stays null.
const FIXED_PHRASE_RULES: FixedPhraseRule[] = [
  // Law enforcement / generic government role attribution — MEDIUM: a real,
  // recognized construction, but naming a role ("police", "officials"),
  // not a specific, checkable organization.
  {
    pattern: /\bpolice (?:said|reported|stated|confirmed)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "LAW_ENFORCEMENT",
  },
  {
    pattern: /\baccording to police\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "LAW_ENFORCEMENT",
  },
  {
    pattern: /\binvestigators (?:said|stated|confirmed|found)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "LAW_ENFORCEMENT",
  },
  {
    pattern: /\bprosecutors (?:said|stated|confirmed|alleged)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "LAW_ENFORCEMENT",
  },
  {
    pattern: /\bofficials (?:said|stated|confirmed)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "GOVERNMENT_AGENCY",
  },
  {
    pattern: /\bauthorities (?:said|stated|confirmed)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "GOVERNMENT_AGENCY",
  },
  // Legal/documentary — HIGH: specific, unambiguous document phrases.
  {
    pattern: /\baccording to court records\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "COURT_FILING",
    confidence: "HIGH",
    entityTypeHint: "COURT",
  },
  {
    pattern: /\baccording to court documents\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "COURT_FILING",
    confidence: "HIGH",
    entityTypeHint: "COURT",
  },
  {
    pattern: /\baccording to the complaint\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "COURT_FILING",
    confidence: "HIGH",
    entityTypeHint: "COURT",
  },
  {
    pattern: /\baccording to the indictment\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "COURT_FILING",
    confidence: "HIGH",
    entityTypeHint: "COURT",
  },
  {
    pattern: /\baccording to an? court filing\b|\baccording to a court filing\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "COURT_FILING",
    confidence: "HIGH",
    entityTypeHint: "COURT",
  },
  // Company / press release — MEDIUM: generic, unnamed company.
  {
    pattern: /\baccording to a company statement\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "PRESS_RELEASE",
    confidence: "MEDIUM",
    entityTypeHint: "COMPANY",
  },
  {
    pattern: /\baccording to a press release\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "PRESS_RELEASE",
    confidence: "MEDIUM",
    entityTypeHint: "COMPANY",
  },
  {
    pattern: /\bthe company (?:said|announced|confirmed|stated)\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "COMPANY",
  },
  // Research — MEDIUM: generic, unnamed institution.
  {
    pattern: /\baccording to the study\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "STUDY_OR_DATASET",
    confidence: "MEDIUM",
    entityTypeHint: "RESEARCH_INSTITUTION",
  },
  {
    pattern: /\bresearchers found\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "STUDY_OR_DATASET",
    confidence: "MEDIUM",
    entityTypeHint: "RESEARCH_INSTITUTION",
  },
  {
    pattern: /\bthe study found\b/gi,
    relationshipType: "CITES_PRIMARY_DOCUMENT",
    evidenceType: "STUDY_OR_DATASET",
    confidence: "MEDIUM",
    entityTypeHint: "RESEARCH_INSTITUTION",
  },
  // Anonymous sourcing — MEDIUM: an explicit, recognized idiom, but by
  // definition no checkable named entity exists behind it.
  {
    pattern: /\baccording to people familiar with the matter\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "ANONYMOUS",
  },
  {
    pattern: /\ba person familiar with the matter said\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "ANONYMOUS",
  },
  {
    pattern: /\bsources familiar with the matter said\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "MEDIUM",
    entityTypeHint: "ANONYMOUS",
  },
  // Deliberately weak: bare "sources said" with no qualifier is vaguer
  // than the "familiar with the matter" idiom above — kept LOW on purpose
  // so persistObservations()'s LOW-filtering has a real, realistic case to
  // filter (see test/provenanceExtraction.test.ts).
  {
    pattern: /\bsources said\b/gi,
    relationshipType: "CITES_STATEMENT",
    evidenceType: "STATEMENT",
    confidence: "LOW",
    entityTypeHint: "ANONYMOUS",
  },
];

export function findFixedPhraseAttributions(text: string): AttributionCandidate[] {
  const candidates: AttributionCandidate[] = [];
  for (const rule of FIXED_PHRASE_RULES) {
    const re = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      candidates.push({
        relationshipType: rule.relationshipType,
        evidenceType: rule.evidenceType,
        confidence: rule.confidence,
        rawEntityText: match[0].trim(),
        entityTypeHint: rule.entityTypeHint,
        requiresEntityResolution: false,
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    }
  }
  return candidates;
}

/**
 * Interview/eyewitness/original-reporting signals. Per Phase 7A/§11's
 * policy, ORIGINAL_REPORTING_CLAIM is only ever asserted when the named
 * publisher in the text matches the CURRENT article's own publisher
 * (passed in as `publisherName`, sourced from Article.source.name) — never
 * inferred from the mere presence of interview/document-review language
 * naming some other, unrelated outlet, and never from silence.
 */
export function findInterviewEyewitnessAttributions(
  text: string,
  publisherName: string | undefined,
): AttributionCandidate[] {
  const candidates: AttributionCandidate[] = [];

  function publisherMatches(captured: string): boolean {
    if (!publisherName) return false;
    const a = captured.trim().toLowerCase();
    const b = publisherName.trim().toLowerCase();
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  function pushEntityCapturingMatch(
    match: RegExpMatchArray,
    entityGroupName: string,
    evidenceType: ProvenanceEvidenceType,
  ) {
    const indices = (match as RegExpMatchArray & { indices: Record<string, [number, number]> })
      .indices;
    const full = indices?.[0];
    const entityRange = indices?.groups?.[entityGroupName];
    if (!full) return;
    const rawEntityText = (match.groups?.[entityGroupName] ?? "").trim();

    if (rawEntityText && publisherMatches(rawEntityText)) {
      candidates.push({
        relationshipType: "ORIGINAL_REPORTING_CLAIM",
        evidenceType,
        confidence: "HIGH",
        rawEntityText,
        entityTypeHint: "NEWS_OUTLET",
        requiresEntityResolution: false,
        startOffset: full[0],
        endOffset: entityRange ? entityRange[1] : full[1],
      });
      return;
    }

    // A named (different) outlet: a real construction, just not
    // confirmed as original to *this* article — CITES_OTHER_OUTLET may
    // still resolve to a known wire-service alias upstream in extract.ts.
    if (rawEntityText) {
      candidates.push({
        relationshipType: "CITES_OTHER_OUTLET",
        evidenceType,
        confidence: "MEDIUM",
        rawEntityText,
        entityTypeHint: "NEWS_OUTLET",
        requiresEntityResolution: false,
        attemptEntityResolution: true,
        startOffset: full[0],
        endOffset: entityRange ? entityRange[1] : full[1],
      });
    }
  }

  const toldRe = new RegExp(`\\btold (?<entity>${NAME_CAPTURE_GREEDY})\\b`, "gd");
  for (const match of text.matchAll(toldRe)) {
    pushEntityCapturingMatch(match, "entity", "INTERVIEW");
  }

  const interviewWithRe = new RegExp(
    `\\b[Ii]n an interview with (?<entity>${NAME_CAPTURE_GREEDY})\\b`,
    "gd",
  );
  for (const match of text.matchAll(interviewWithRe)) {
    pushEntityCapturingMatch(match, "entity", "INTERVIEW");
  }

  const documentsReviewedRe = new RegExp(
    `\\b[Dd]ocuments reviewed by (?<entity>${NAME_CAPTURE_GREEDY})\\b`,
    "gd",
  );
  for (const match of text.matchAll(documentsReviewedRe)) {
    pushEntityCapturingMatch(match, "entity", "UNKNOWN");
  }

  const eyewitnessToldRe = new RegExp(
    `\\b[Ee]yewitnesses told (?<entity>${NAME_CAPTURE_GREEDY})\\b`,
    "gd",
  );
  for (const match of text.matchAll(eyewitnessToldRe)) {
    pushEntityCapturingMatch(match, "entity", "EYEWITNESS_ACCOUNT");
  }

  // Bare eyewitness sourcing with no captured publisher — a real
  // construction, but without a name to compare, we can't confirm it's
  // original to this article. MEDIUM, relationshipType stays generic.
  const bareEyewitnessRe = /\beyewitnesses (?:told|said)\b/gi;
  for (const match of text.matchAll(bareEyewitnessRe)) {
    if (match.index === undefined) continue;
    candidates.push({
      relationshipType: "CITES_STATEMENT",
      evidenceType: "EYEWITNESS_ACCOUNT",
      confidence: "MEDIUM",
      rawEntityText: "eyewitnesses",
      entityTypeHint: "ANONYMOUS",
      requiresEntityResolution: false,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // Self-referential: "the/this/our reporter witnessed" — grammatically
  // self-refers to whoever wrote the current piece (a different outlet's
  // article naming its OWN reporter this way wouldn't appear, unattributed,
  // inside another publication's excerpt without itself being named first,
  // e.g. "[Outlet]'s reporter witnessed..." — the negative lookbehind for a
  // preceding possessive rejects exactly that case).
  const reporterWitnessedRe = /(?<!['’]s )\b(?:the|this|our) reporter witnessed\b/gi;
  for (const match of text.matchAll(reporterWitnessedRe)) {
    if (match.index === undefined) continue;
    candidates.push({
      relationshipType: "ORIGINAL_REPORTING_CLAIM",
      evidenceType: "EYEWITNESS_ACCOUNT",
      confidence: "HIGH",
      rawEntityText: "the reporter",
      entityTypeHint: "INDIVIDUAL",
      requiresEntityResolution: false,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return candidates;
}

/** Runs every matcher and returns the raw, unfiltered candidate list (overlap suppression happens in extract.ts). */
export function findAllCandidates(
  text: string,
  publisherName: string | undefined,
): AttributionCandidate[] {
  return [
    ...findNamedEntityAttributions(text),
    ...findFixedPhraseAttributions(text),
    ...findInterviewEyewitnessAttributions(text, publisherName),
  ];
}
