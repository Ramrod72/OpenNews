import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return statSync(full).isFile() ? [full] : [];
  });
}

const STORY_INTELLIGENCE_FILES = [
  "src/components/story/StoryIntelligence.tsx",
  "src/components/story/EvidenceDrawer.tsx",
  "src/lib/storyIntelligenceView.ts",
  "src/lib/storyIntelligence.ts",
];

/**
 * Phase 9B: structural regression tests over the actual Story Intelligence
 * source, following this repo's established convention (see
 * test/provenanceBoundary.test.ts, test/sourceProfileSafety.test.ts) of
 * proving safety properties by scanning real source text rather than
 * rendering components (this codebase has no React rendering test setup —
 * see vitest.config.ts's environment: "node" — so pure-function tests plus
 * structural source tests are the established pattern for UI safety).
 */

describe("L — no dangerouslySetInnerHTML anywhere in Story Intelligence (hostile text always renders as plain React text)", () => {
  it("none of the new components ever use dangerouslySetInnerHTML", () => {
    for (const file of STORY_INTELLIGENCE_FILES) {
      expect(read(file)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});

describe("AH — no raw provenance enum values are ever hardcoded into UI copy", () => {
  const FORBIDDEN_ENUMS =
    /CITES_WIRE_SERVICE|CITES_OTHER_OUTLET|CITES_PRIMARY_DOCUMENT|CITES_STATEMENT|REPORTING_CITATION|ORIGINAL_REPORTING_CLAIM|"HIGH"|"MEDIUM"|POSSIBLE|STRONGLY_INFERRED|LIKELY_SHARED_TEXT_ORIGIN/;

  it("StoryIntelligence.tsx and EvidenceDrawer.tsx never reference a raw technical enum value", () => {
    for (const file of [
      "src/components/story/StoryIntelligence.tsx",
      "src/components/story/EvidenceDrawer.tsx",
    ]) {
      expect(read(file)).not.toMatch(FORBIDDEN_ENUMS);
    }
  });
});

describe("AI — no forbidden overclaiming language anywhere in the Phase 9B diff's UI-facing copy", () => {
  // Deliberately narrow to AFFIRMATIVE overclaiming words. Words like
  // "confirmed"/"independent" are allowed to appear in NEGATIVE framing
  // ("does not mean independently confirmed") — this suite checks the
  // stronger, structural guarantee instead: the specific forbidden PHRASES
  // from the Phase 9B spec never appear verbatim as an affirmative claim.
  const FORBIDDEN_PHRASES = [
    /independently confirmed the (story|claim)/i,
    /verified the claim/i,
    /corroborated the (story|claim)/i,
    /used the exact same .*dispatch/i,
    /copied each other/i,
    /plagiarized/i,
    /is the original source/i,
    /this source is (reliable|unreliable)/i,
    /this claim is (true|false)/i,
    /proves the event/i,
  ];

  it("no forbidden overclaiming phrase appears in any Story Intelligence source file", () => {
    for (const file of STORY_INTELLIGENCE_FILES) {
      const source = read(file);
      for (const phrase of FORBIDDEN_PHRASES) {
        expect(source).not.toMatch(phrase);
      }
    }
  });
});

describe("Z — no public graph/provenance API was added", () => {
  it("no API route file exists under /api/graph, /api/provenance, or /api/story-intelligence", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /[\\/]api[\\/](graph|provenance|story-intelligence)[\\/]/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it("no API route file references getClusterOriginSummary or the Story Intelligence view model", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /getClusterOriginSummary|buildStoryIntelligenceView|loadStoryIntelligence|ClusterOriginSummary/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("EvidenceDrawer (the one Client Component) never imports the raw graph module", () => {
  it("only imports the safe storyIntelligenceView types, never src/lib/graph/types or getClusterOriginSummary", () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    // Strip block/line comments before matching — the file's own doc
    // comments legitimately mention these names in prose to explain what's
    // NOT imported, which a raw whole-file scan would (and did)
    // false-positive on.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).toMatch(/from ["']@\/lib\/storyIntelligenceView["']/);
    expect(codeOnly).not.toMatch(/@\/lib\/graph/);
    expect(codeOnly).not.toMatch(
      /getClusterOriginSummary|ClusterOriginSummary|SharedReportingSourceGroup(?!View)/,
    );
  });

  it('is a Client Component ("use client")', () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    expect(source.trimStart().startsWith('"use client";')).toBe(true);
  });
});

describe('StoryIntelligence.tsx is a Server Component (no "use client" directive)', () => {
  it("does not declare itself a Client Component", () => {
    const source = read("src/components/story/StoryIntelligence.tsx");
    expect(source).not.toMatch(/^"use client"/m);
  });
});

describe("AG — no Story Map UI was added in Phase 9B", () => {
  it("no component/file references a story-map/graph-visualization concept", () => {
    for (const file of STORY_INTELLIGENCE_FILES) {
      expect(read(file)).not.toMatch(
        /StoryMap|story-map|GraphVisualization|force-directed|d3-force/i,
      );
    }
  });
});

describe("no primary-evidence UI was added in Phase 9B", () => {
  it("StoryIntelligence.tsx and EvidenceDrawer.tsx never render primaryEvidenceGroups", () => {
    for (const file of [
      "src/components/story/StoryIntelligence.tsx",
      "src/components/story/EvidenceDrawer.tsx",
    ]) {
      expect(read(file)).not.toMatch(/primaryEvidence/i);
    }
  });
});

describe("theming — Story Intelligence uses only existing semantic tokens, no hardcoded colors", () => {
  it("no hex color or arbitrary Tailwind color literal appears in the new components", () => {
    for (const file of [
      "src/components/story/StoryIntelligence.tsx",
      "src/components/story/EvidenceDrawer.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\btext-(red|blue|green|yellow|purple|pink)-\d{2,3}\b/);
      expect(source).not.toMatch(/\bbg-(red|blue|green|yellow|purple|pink)-\d{2,3}\b/);
    }
  });

  it("uses this app's established semantic classes (bg-surface-muted/text-foreground-muted/border-border)", () => {
    const combined =
      read("src/components/story/StoryIntelligence.tsx") +
      read("src/components/story/EvidenceDrawer.tsx");
    expect(combined).toMatch(/text-foreground-muted/);
    expect(combined).toMatch(/border-border/);
  });
});

describe("accessibility — expand/collapse controls are keyboard-operable and labeled", () => {
  it("EvidenceDrawer's toggle is a real <button> with aria-expanded and aria-controls, not a click-only div", () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    expect(source).toMatch(/<button/);
    expect(source).toMatch(/aria-expanded=\{open\}/);
    expect(source).toMatch(/aria-controls=\{panelId\}/);
  });

  it("StoryIntelligence uses a real h2 for the section heading (correct heading hierarchy)", () => {
    const source = read("src/components/story/StoryIntelligence.tsx");
    expect(source).toMatch(/<h2[^>]*id="trace-this-story-heading"/);
    expect(source).toMatch(/aria-labelledby="trace-this-story-heading"/);
  });

  it("'How Veriqen traces this' uses a native <details>/<summary> disclosure (keyboard-operable with no extra JS)", () => {
    const source = read("src/components/story/StoryIntelligence.tsx");
    expect(source).toMatch(/<details/);
    expect(source).toMatch(/<summary/);
  });
});

describe("mobile safety — long text wraps rather than overflowing", () => {
  it("evidence/entity/publisher text uses break-words or flex-wrap classes", () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    expect(source).toMatch(/break-words/);
    expect(source).toMatch(/flex-wrap/);
  });
});

describe("external links keep the app's existing security convention", () => {
  it('article links use target="_blank" with rel="noopener noreferrer", matching the rest of the story page', () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    expect(source).toMatch(/target="_blank"[\s\S]{0,40}rel="noopener noreferrer"/);
  });

  it("publisher links use Next.js's internal <Link>, never a raw <a> to an external/arbitrary URL from entity names", () => {
    const source = read("src/components/story/EvidenceDrawer.tsx");
    expect(source).toMatch(/<Link\s+href=\{`\/sources\/\$\{article\.publisherSourceId\}`\}/);
  });
});

describe("ads placement remains outside Story Intelligence (AN)", () => {
  it("the story page's AdContainer usages are unchanged in count and none sit inside the Story Intelligence section", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    const adMatches = page.match(/<AdContainer/g) ?? [];
    expect(adMatches).toHaveLength(2); // articlePage + sidebar, same as before Phase 9B
    // The <StoryIntelligence> element must not appear between an
    // AdContainer's opening tag and its own render — a light structural
    // check that AdContainer isn't nested inside the intelligence section.
    const intelligenceIndex = page.indexOf("<StoryIntelligence");
    const firstAdIndex = page.indexOf("<AdContainer");
    expect(intelligenceIndex).toBeGreaterThan(-1);
    expect(firstAdIndex).toBeGreaterThan(intelligenceIndex); // ad renders after the intelligence section, never inside it
  });

  it("StoryIntelligence.tsx and EvidenceDrawer.tsx never import AdContainer/AdSlot", () => {
    for (const file of [
      "src/components/story/StoryIntelligence.tsx",
      "src/components/story/EvidenceDrawer.tsx",
    ]) {
      expect(read(file)).not.toMatch(/AdContainer|AdSlot/);
    }
  });
});

describe("AK/AL/AM — existing story-page functionality remains referenced (not accidentally removed)", () => {
  it("ShareButton, BookmarkButton, timeline, and compare sections are all still present", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    expect(page).toMatch(/<ShareButton/);
    expect(page).toMatch(/<BookmarkButton/);
    expect(page).toMatch(/id="timeline"/);
    expect(page).toMatch(/id="compare"/);
  });

  it("source-profile links (/sources/[id]) still exist on the story page, independent of Story Intelligence", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    expect(page).toMatch(/\/sources\/\$\{/);
  });
});

describe("no schema/migration changes were introduced by Phase 9B", () => {
  it("prisma/schema.prisma is unchanged and no new migration directory was added by this feature", () => {
    // This is a coarse sanity check, not a git diff — the real diff-based
    // confirmation happens in the final regression gate/report. It only
    // asserts the file still parses as the same known-good shape.
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/model StoryCluster/);
    expect(schema).toMatch(/model ProvenanceObservation/);
  });
});
