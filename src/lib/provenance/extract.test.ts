import { describe, expect, it } from "vitest";
import { extractObservations } from "./extract";
import { buildAliasIndex, type AliasRecord } from "./entityResolution";
import provenanceAliasesConfig from "../../../config/provenanceAliases.json";
import type { ProvenanceEntityType, ProvenanceAliasMatchType } from "@/lib/validation/provenance";

/**
 * Builds the alias index from the REAL shipped seed config
 * (config/provenanceAliases.json), not a hand-duplicated stand-in — so
 * these tests exercise the actual data Phase 7B ships, and a future seed
 * edit that breaks resolution fails here, not silently in production.
 */
function buildRealAliasIndex() {
  const records: AliasRecord[] = [];
  for (const entity of provenanceAliasesConfig as Array<{
    canonicalName: string;
    entityType: string;
    aliases: Array<{ text: string; matchType: string }>;
  }>) {
    for (const alias of entity.aliases) {
      records.push({
        entityId: entity.canonicalName, // stable enough for test assertions
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

const aliasIndex = buildRealAliasIndex();

function extract(text: string, publisherName?: string) {
  return extractObservations(text, aliasIndex, publisherName);
}

describe("named wire-service attribution", () => {
  it("1. Reuters reported...", () => {
    const obs = extract("Reuters reported the deal closed on Friday.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_WIRE_SERVICE");
    expect(obs[0].confidence).toBe("HIGH");
    expect(obs[0].resolvedEntity?.canonicalName).toBe("Reuters");
  });

  it("2. according to Reuters...", () => {
    const obs = extract("According to Reuters, the deal closed on Friday.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_WIRE_SERVICE");
    expect(obs[0].confidence).toBe("HIGH");
  });

  it("3. AP reported... (short EXACT alias -> capped at MEDIUM)", () => {
    const obs = extract("AP reported the news on Monday.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_WIRE_SERVICE");
    expect(obs[0].confidence).toBe("MEDIUM");
    expect(obs[0].resolvedEntity?.canonicalName).toBe("Associated Press");
  });

  it("4. according to the Associated Press... (full name -> HIGH)", () => {
    const obs = extract("According to the Associated Press, the news broke on Monday.");
    expect(obs).toHaveLength(1);
    expect(obs[0].confidence).toBe("HIGH");
  });
});

describe("official/government attribution", () => {
  it("5. DOJ said... (short EXACT alias -> MEDIUM)", () => {
    const obs = extract("DOJ said the investigation was ongoing.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_STATEMENT");
    expect(obs[0].confidence).toBe("MEDIUM");
    expect(obs[0].resolvedEntity?.canonicalName).toBe("U.S. Department of Justice");
  });

  it("6. according to the Department of Justice... (full name -> HIGH)", () => {
    const obs = extract("According to the Department of Justice, the case is closed.");
    expect(obs).toHaveLength(1);
    expect(obs[0].confidence).toBe("HIGH");
  });

  it("7. FBI said... (short EXACT alias -> MEDIUM)", () => {
    const obs = extract("The FBI said the search was ongoing.");
    expect(obs).toHaveLength(1);
    expect(obs[0].resolvedEntity?.canonicalName).toBe("Federal Bureau of Investigation");
    expect(obs[0].confidence).toBe("MEDIUM");
  });
});

describe("law enforcement / generic role attribution", () => {
  it("8. police said...", () => {
    const obs = extract("Police said the suspect fled the scene.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_STATEMENT");
    expect(obs[0].confidence).toBe("MEDIUM");
    expect(obs[0].resolvedEntity).toBeNull();
  });

  it("9. according to police...", () => {
    const obs = extract("According to police, the suspect fled the scene.");
    expect(obs).toHaveLength(1);
    expect(obs[0].confidence).toBe("MEDIUM");
  });
});

describe("legal/documentary attribution", () => {
  it("10. according to court records...", () => {
    const obs = extract("According to court records, the case was dismissed.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_PRIMARY_DOCUMENT");
    expect(obs[0].evidenceType).toBe("COURT_FILING");
    expect(obs[0].confidence).toBe("HIGH");
  });

  it("11. according to a court filing...", () => {
    const obs = extract("According to a court filing, the allegations were detailed.");
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe("COURT_FILING");
  });

  it("12. according to the indictment...", () => {
    const obs = extract("According to the indictment, the scheme lasted years.");
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe("COURT_FILING");
  });

  it("13. according to a press release...", () => {
    const obs = extract("According to a press release, sales rose sharply.");
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe("PRESS_RELEASE");
    expect(obs[0].confidence).toBe("MEDIUM");
  });
});

describe("research attribution", () => {
  it("14. according to the study...", () => {
    const obs = extract("According to the study, the effect was significant.");
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe("STUDY_OR_DATASET");
  });

  it("15. researchers found...", () => {
    const obs = extract("Researchers found a new link between diet and health.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_PRIMARY_DOCUMENT");
  });
});

describe("anonymous sourcing", () => {
  it("16. person familiar with the matter...", () => {
    const obs = extract("A person familiar with the matter said the deal was near.");
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe("STATEMENT");
    expect(obs[0].confidence).toBe("MEDIUM");
  });
});

describe("interview / documents / eyewitness language", () => {
  it("17. interview language (matching publisher -> ORIGINAL_REPORTING_CLAIM)", () => {
    const obs = extract(
      "In an interview with The Guardian, the CEO said sales rose.",
      "The Guardian",
    );
    expect(obs.some((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM")).toBe(true);
    const claim = obs.find((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM")!;
    expect(claim.confidence).toBe("HIGH");
  });

  it("18. documents reviewed by... (matching publisher)", () => {
    const obs = extract("Documents reviewed by The Guardian show new details.", "The Guardian");
    expect(obs.some((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM")).toBe(true);
  });

  it("18b. documents reviewed by a resolvable wire service -> CITES_WIRE_SERVICE, not original reporting", () => {
    const obs = extract("Documents reviewed by Reuters show new evidence.", "The Guardian");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_WIRE_SERVICE");
  });

  it("19. eyewitness language (matching publisher)", () => {
    const obs = extract(
      "Eyewitnesses told The Guardian the blast shook nearby buildings.",
      "The Guardian",
    );
    const claim = obs.find((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM");
    expect(claim).toBeDefined();
    expect(claim!.evidenceType).toBe("EYEWITNESS_ACCOUNT");
  });

  it("bare eyewitness language with no captured publisher stays MEDIUM/CITES_STATEMENT, never an unconfirmed original-reporting claim", () => {
    const obs = extract("Eyewitnesses said the blast shook nearby buildings.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).not.toBe("ORIGINAL_REPORTING_CLAIM");
    expect(obs[0].confidence).toBe("MEDIUM");
  });

  it("the reporter witnessed... is self-referential ORIGINAL_REPORTING_CLAIM with no publisher needed", () => {
    const obs = extract("This reporter witnessed the explosion firsthand.");
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("ORIGINAL_REPORTING_CLAIM");
    expect(obs[0].confidence).toBe("HIGH");
  });

  it("interview/documents/eyewitness naming a DIFFERENT outlet than the publisher is NOT an original-reporting claim", () => {
    const obs = extract("In an interview with CNN, the CEO said sales rose.", "The Guardian");
    expect(obs.some((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM")).toBe(false);
    expect(obs).toHaveLength(1);
    expect(obs[0].relationshipType).toBe("CITES_OTHER_OUTLET");
    expect(obs[0].confidence).toBe("MEDIUM");
  });

  it("no publisherName supplied at all -> never asserts ORIGINAL_REPORTING_CLAIM for a named-entity interview", () => {
    const obs = extract("In an interview with The Guardian, the CEO said sales rose.");
    expect(obs.some((o) => o.relationshipType === "ORIGINAL_REPORTING_CLAIM")).toBe(false);
  });
});

describe("multiple / duplicate / nested observations", () => {
  it("20. multiple observations in one input", () => {
    const obs = extract(
      "Reuters reported the deal closed. According to police, no injuries were reported.",
    );
    expect(obs.length).toBeGreaterThanOrEqual(2);
    expect(obs.some((o) => o.relationshipType === "CITES_WIRE_SERVICE")).toBe(true);
    expect(obs.some((o) => o.rawEntityText.toLowerCase().includes("police"))).toBe(true);
  });

  it("21. duplicate identical attribution appearing twice produces two distinct, separately-offset observations", () => {
    const obs = extract(
      "Reuters reported the deal. Later, Reuters reported the deal fell through.",
    );
    expect(obs).toHaveLength(2);
    expect(obs[0].startOffset).not.toBe(obs[1].startOffset);
  });

  it("26. nested attribution: captures the reliable outer attribution without inventing a full chain", () => {
    const obs = extract("AP reported that police said the suspect fled.");
    expect(obs).toHaveLength(2);
    expect(obs[0].relationshipType).toBe("CITES_WIRE_SERVICE");
    expect(obs[0].evidenceText).toBe("AP reported");
    expect(obs[1].rawEntityText.toLowerCase()).toContain("police");
  });

  it("overlapping fixed-phrase matches are suppressed in favor of the more specific one", () => {
    const obs = extract("Sources familiar with the matter said the deal was near.");
    expect(obs).toHaveLength(1);
    expect(obs[0].confidence).toBe("MEDIUM"); // the specific idiom, not the bare LOW "sources said" pattern
  });
});

describe("malformed / unicode / boundary text", () => {
  it("22. unicode punctuation (curly apostrophe) does not break matching", () => {
    const obs = extract("The FBI’s investigation continues, the FBI said.");
    expect(obs).toHaveLength(1);
    expect(obs[0].resolvedEntity?.canonicalName).toBe("Federal Bureau of Investigation");
  });

  it("23. malformed/truncated text does not throw", () => {
    expect(() => extract("Reuters repor")).not.toThrow();
    expect(() => extract("")).not.toThrow();
    expect(() => extract("   ")).not.toThrow();
  });

  it("24. HTML entities: already-decoded text (as toPlainText produces) matches normally", () => {
    const obs = extract("AP reported the news.");
    expect(obs).toHaveLength(1);
  });

  it("25. long input near the 8000-char sanitation boundary still finds a match anywhere in it", () => {
    const filler = "This is unrelated filler text. ".repeat(240); // ~7680 chars
    const text = `${filler}Reuters reported the deal closed.`;
    const obs = extract(text);
    expect(obs).toHaveLength(1);
    expect(obs[0].startOffset).toBe(filler.length);
  });
});

describe("false positives — must produce zero (or non-wire) observations", () => {
  it("27. Reuters, California is... (geographic mention, no attribution verb)", () => {
    expect(extract("Reuters, California is a small town in the Central Valley.")).toHaveLength(0);
  });

  it("28. bare Reuters mention with no verb", () => {
    expect(extract("Reuters: Fed expected to cut rates next month")).toHaveLength(0);
  });

  it("29. bare AP token with no attribution verb nearby", () => {
    expect(extract("AP Calculus students said the exam was hard.")).toHaveLength(0);
  });

  it("30. Reuters did not report...", () => {
    expect(extract("Reuters did not report the allegations.")).toHaveLength(0);
  });

  it("31. Reuters never said...", () => {
    expect(extract("Reuters never said the deal was final.")).toHaveLength(0);
  });

  it("32. Reuters may report...", () => {
    expect(extract("Reuters may report on this later today.")).toHaveLength(0);
  });

  it("33. AP could report...", () => {
    expect(extract("AP could report on this tomorrow.")).toHaveLength(0);
  });

  it("34. ...is expected to report (speculation across a longer gap)", () => {
    expect(extract("Reuters is expected to report on this tomorrow.")).toHaveLength(0);
  });

  it("35. embedded word matches (verb substring inside a longer word)", () => {
    expect(extract("The bridge was underreported in official statistics.")).toHaveLength(0);
  });

  it("36. unrelated AP abbreviation with no attribution verb", () => {
    expect(extract("She is taking AP Chemistry and AP Physics this year.")).toHaveLength(0);
  });

  it("quoted speculation is rejected by the same speculation guard, without needing quote-span detection", () => {
    expect(extract('"Reuters may report on this," she said.')).toHaveLength(0);
  });

  it("a headline mentioning an outlet without any attribution verb", () => {
    expect(extract("Reuters wins award for investigative journalism")).toHaveLength(0);
  });
});

describe("confidence policy", () => {
  it("37. HIGH observations are produced by the extractor", () => {
    const obs = extract("Reuters reported the deal closed.");
    expect(obs.some((o) => o.confidence === "HIGH")).toBe(true);
  });

  it("38. MEDIUM observations are produced by the extractor", () => {
    const obs = extract("Police said the suspect fled.");
    expect(obs.some((o) => o.confidence === "MEDIUM")).toBe(true);
  });

  it('39. the extractor CAN internally produce LOW (bare "sources said") — persistObservations.ts is responsible for filtering it, not this module', () => {
    const obs = extract("Sources said the deal was near collapse.");
    expect(obs).toHaveLength(1);
    expect(obs[0].confidence).toBe("LOW");
  });
});
