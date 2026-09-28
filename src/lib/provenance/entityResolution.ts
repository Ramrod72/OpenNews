import type { ProvenanceAliasMatchType, ProvenanceEntityType } from "@/lib/validation/provenance";

/**
 * Pure, in-memory alias resolution — no DB access here. The caller (worker
 * ingestion, backfill) loads the small alias table once per run/tick and
 * builds an index via buildAliasIndex(), rather than this module querying
 * the database once per regex match (see ARCHITECTURE.md's Phase 7
 * performance notes — the alias table is small enough to cache in full).
 */
export interface AliasRecord {
  entityId: string;
  entityType: ProvenanceEntityType;
  canonicalName: string;
  aliasText: string;
  normalizedAlias: string;
  matchType: ProvenanceAliasMatchType;
}

export interface ResolvedEntity {
  entityId: string;
  entityType: ProvenanceEntityType;
  canonicalName: string;
  matchType: ProvenanceAliasMatchType;
  /** The specific alias text that matched (not the raw captured phrase, which may include extra leading words like "The") — used to judge whether the matched alias itself is a short, ambiguous token. */
  aliasText: string;
}

export type AliasIndex = Map<string, AliasRecord[]>;

export function buildAliasIndex(aliases: AliasRecord[]): AliasIndex {
  const index: AliasIndex = new Map();
  for (const alias of aliases) {
    const list = index.get(alias.normalizedAlias) ?? [];
    list.push(alias);
    index.set(alias.normalizedAlias, list);
  }
  return index;
}

/**
 * Resolves a raw matched string (e.g. "AP", "Reuters") against the known
 * alias index. Returns null if unresolved — callers must discard the
 * candidate observation entirely rather than guess (precision-first
 * policy), never fabricate a low-quality entity row on the fly.
 *
 * EXACT match types require the candidate's case to match the alias's
 * stored case exactly (e.g. "AP" but not "ap" or "Ap") — this is the
 * specific defense against ambiguous short abbreviations (see §5/§10 of
 * the Phase 7A design and the seed data in config/provenanceAliases.json).
 * CASE_INSENSITIVE match types only need to match at the normalized
 * (lowercased/trimmed) level, since SQLite doesn't support Prisma's
 * `mode: "insensitive"` DB-level queries (see ARCHITECTURE.md's Search
 * section for the same constraint elsewhere in this app) — comparing
 * normalizedAlias here, in application code, sidesteps that entirely.
 */
export function resolveEntity(rawText: string, index: AliasIndex): ResolvedEntity | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase();
  const candidates = index.get(normalized);
  if (!candidates || candidates.length === 0) return null;

  for (const alias of candidates) {
    if (alias.matchType === "EXACT" && alias.aliasText !== trimmed) continue;
    return {
      entityId: alias.entityId,
      entityType: alias.entityType,
      canonicalName: alias.canonicalName,
      matchType: alias.matchType,
      aliasText: alias.aliasText,
    };
  }
  return null;
}
