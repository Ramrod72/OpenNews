import { describe, expect, it } from "vitest";
import { buildAliasIndex, resolveEntity, type AliasRecord } from "./entityResolution";
import provenanceAliasesConfig from "../../../config/provenanceAliases.json";
import type { ProvenanceAliasMatchType, ProvenanceEntityType } from "@/lib/validation/provenance";

function buildRealAliasIndex() {
  const records: AliasRecord[] = [];
  for (const entity of provenanceAliasesConfig as Array<{
    canonicalName: string;
    entityType: string;
    aliases: Array<{ text: string; matchType: string }>;
  }>) {
    for (const alias of entity.aliases) {
      records.push({
        entityId: entity.canonicalName,
        entityType: entity.entityType as ProvenanceEntityType,
        canonicalName: entity.canonicalName,
        aliasText: alias.text,
        normalizedAlias: alias.text.trim().toLowerCase(),
        matchType: alias.matchType as ProvenanceAliasMatchType,
      });
    }
  }
  return buildAliasIndex(records);
}

const index = buildRealAliasIndex();

describe("entity resolution — real shipped seed data", () => {
  it("40. every Reuters alias resolves to the same canonical entity", () => {
    for (const alias of ["Reuters", "reuters", "REUTERS", "Reuters News", "Thomson Reuters"]) {
      const resolved = resolveEntity(alias, index);
      expect(resolved?.canonicalName).toBe("Reuters");
      expect(resolved?.entityType).toBe("WIRE_SERVICE");
    }
  });

  it("41. AP resolves only via an exact-case match, never lowercase/mixed-case", () => {
    expect(resolveEntity("AP", index)?.canonicalName).toBe("Associated Press");
    expect(resolveEntity("ap", index)).toBeNull();
    expect(resolveEntity("Ap", index)).toBeNull();
    // Full-name variants resolve case-insensitively, unlike the bare abbreviation.
    expect(resolveEntity("associated press", index)?.canonicalName).toBe("Associated Press");
    expect(resolveEntity("THE ASSOCIATED PRESS", index)?.canonicalName).toBe("Associated Press");
  });

  it("42. every DOJ alias resolves to the same canonical entity; bare DOJ requires exact case", () => {
    expect(resolveEntity("Department of Justice", index)?.canonicalName).toBe(
      "U.S. Department of Justice",
    );
    expect(resolveEntity("U.S. Department of Justice", index)?.canonicalName).toBe(
      "U.S. Department of Justice",
    );
    expect(resolveEntity("DOJ", index)?.canonicalName).toBe("U.S. Department of Justice");
    expect(resolveEntity("doj", index)).toBeNull();
  });

  it("43. every FBI alias resolves to the same canonical entity; bare FBI requires exact case", () => {
    expect(resolveEntity("Federal Bureau of Investigation", index)?.canonicalName).toBe(
      "Federal Bureau of Investigation",
    );
    expect(resolveEntity("FBI", index)?.canonicalName).toBe("Federal Bureau of Investigation");
    expect(resolveEntity("fbi", index)).toBeNull();
    expect(resolveEntity("Fbi", index)).toBeNull();
  });

  it("44. an unresolved entity returns null — callers retain the raw text themselves, this module never invents a fallback", () => {
    expect(resolveEntity("The White House", index)).toBeNull();
    expect(resolveEntity("Some Random Outlet", index)).toBeNull();
    expect(resolveEntity("", index)).toBeNull();
    expect(resolveEntity("   ", index)).toBeNull();
  });

  it("45. resolution is deterministic — repeated calls with the same input always agree", () => {
    const results = Array.from({ length: 5 }, () => resolveEntity("Reuters", index)?.entityId);
    expect(new Set(results).size).toBe(1);
    const apResults = Array.from({ length: 5 }, () => resolveEntity("AP", index)?.entityId);
    expect(new Set(apResults).size).toBe(1);
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(resolveEntity("  Reuters  ", index)?.canonicalName).toBe("Reuters");
  });
});
