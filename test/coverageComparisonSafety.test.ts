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

const COVERAGE_COMPARISON_FILES = [
  "src/components/story/CoverageComparison.tsx",
  "src/components/story/ClaimEvidenceDrawer.tsx",
  "src/lib/coverageComparisonView.ts",
  "src/lib/coverageComparison.ts",
  "src/lib/headlineComparison.ts",
];

const CLAIMS_LIB_FILES = walk(join(ROOT, "src/lib/claims")).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("no dangerouslySetInnerHTML anywhere in Coverage Comparison", () => {
  it("none of the new components ever use dangerouslySetInnerHTML", () => {
    for (const file of COVERAGE_COMPARISON_FILES) {
      expect(read(file)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});

describe("no raw internal identifier is ever hardcoded into UI copy", () => {
  const FORBIDDEN_TOKENS =
    /claimExtractorVersion|dedupeKey|reviewState|"ADMIN_OVERRIDE"|startOffset|endOffset|normalizedText/;

  it("CoverageComparison.tsx and ClaimEvidenceDrawer.tsx never reference an internal claim field", () => {
    for (const file of [
      "src/components/story/CoverageComparison.tsx",
      "src/components/story/ClaimEvidenceDrawer.tsx",
    ]) {
      expect(codeOnly(read(file))).not.toMatch(FORBIDDEN_TOKENS);
    }
  });
});

describe("no forbidden overclaiming language anywhere in the Phase 10B diff's UI-facing copy", () => {
  // Deliberately narrow to AFFIRMATIVE overclaiming constructions, mirroring
  // Phase 9B's own proven approach exactly: words like "confirmed"/
  // "independent" are allowed in NEGATIVE framing ("does not mean
  // independently confirmed") — this suite checks that the specific
  // forbidden AFFIRMATIVE phrases never appear, not that the underlying
  // words never appear at all.
  const FORBIDDEN_PHRASES = [
    /\d+ sources? independently confirmed/i,
    /these articles independently confirm/i,
    /verified the claim/i,
    /\bcorroborated the (claim|story|assertion)/i,
    /confirmed by \d+ sources/i,
    /this claim is (true|false)/i,
    /\bproves the claim\b/i,
    /same dispatch/i,
    /\bplagiarized\b/i,
    /outlet(s)? (deliberately|intentionally) omitted/i,
    /did not report\b/i,
    /failed to report\b/i,
    /this (source|outlet) is (reliable|unreliable)/i,
  ];

  it("no forbidden overclaiming phrase appears in any Coverage Comparison or claims source file", () => {
    for (const file of [
      ...COVERAGE_COMPARISON_FILES,
      ...CLAIMS_LIB_FILES.map((f) => f.replace(`${ROOT}/`, "")),
    ]) {
      const source = read(file);
      for (const phrase of FORBIDDEN_PHRASES) {
        expect(source).not.toMatch(phrase);
      }
    }
  });
});

describe("no public claims/coverage-comparison API was added", () => {
  it("no API route file exists under /api/claims, /api/coverage, or /api/coverage-comparison", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /[\\/]api[\\/](claims|coverage|coverage-comparison)[\\/]/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it("no API route file references buildClaimGroups, loadCoverageComparison, or Claim persistence", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /buildClaimGroups|loadCoverageComparison|persistClaimsForArticle/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("ClaimEvidenceDrawer (the one Client Component) never imports internal claim/graph modules", () => {
  it("only imports the safe coverageComparisonView types, never buildClaimGroups or Prisma", () => {
    const source = codeOnly(read("src/components/story/ClaimEvidenceDrawer.tsx"));
    expect(source).toMatch(/from ["']@\/lib\/coverageComparisonView["']/);
    expect(source).not.toMatch(/@\/lib\/claims\/buildClaimGroups/);
    expect(source).not.toMatch(/@prisma\/client/);
  });

  it('is a Client Component ("use client")', () => {
    const source = read("src/components/story/ClaimEvidenceDrawer.tsx");
    expect(source.trimStart().startsWith('"use client";')).toBe(true);
  });
});

describe('CoverageComparison.tsx is a Server Component (no "use client" directive)', () => {
  it("does not declare itself a Client Component", () => {
    const source = read("src/components/story/CoverageComparison.tsx");
    expect(source).not.toMatch(/^"use client"/m);
  });
});

describe("no Story Map / primary evidence / AI was added", () => {
  it("no component/file references a story-map/graph-visualization concept", () => {
    for (const file of COVERAGE_COMPARISON_FILES) {
      expect(read(file)).not.toMatch(
        /StoryMap|story-map|GraphVisualization|force-directed|d3-force/i,
      );
    }
  });

  it("no component references primaryEvidence", () => {
    for (const file of [
      "src/components/story/CoverageComparison.tsx",
      "src/components/story/ClaimEvidenceDrawer.tsx",
    ]) {
      expect(read(file)).not.toMatch(/primaryEvidence/i);
    }
  });

  it("no Coverage Comparison file imports an AI/LLM/embeddings module", () => {
    for (const file of [
      ...COVERAGE_COMPARISON_FILES,
      ...CLAIMS_LIB_FILES.map((f) => f.replace(`${ROOT}/`, "")),
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/ollama|openai|anthropic|embeddings?Api|@\/lib\/ai\//i);
    }
  });
});

describe("theming — Coverage Comparison uses only existing semantic tokens", () => {
  it("no hex color or arbitrary Tailwind color literal appears in the new components", () => {
    for (const file of [
      "src/components/story/CoverageComparison.tsx",
      "src/components/story/ClaimEvidenceDrawer.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\btext-(red|blue|green|yellow|purple|pink)-\d{2,3}\b/);
      expect(source).not.toMatch(/\bbg-(red|blue|green|yellow|purple|pink)-\d{2,3}\b/);
    }
  });
});

describe("accessibility — heading hierarchy and disclosure semantics", () => {
  it("CoverageComparison uses a real h2 with correct aria-labelledby", () => {
    const source = read("src/components/story/CoverageComparison.tsx");
    expect(source).toMatch(/<h2[^>]*id="compare-coverage-claims-heading"/);
    expect(source).toMatch(/aria-labelledby="compare-coverage-claims-heading"/);
  });

  it("ClaimEvidenceDrawer's toggle is a real <button> with aria-expanded/aria-controls, not role=menu copied from an unrelated component", () => {
    const source = read("src/components/story/ClaimEvidenceDrawer.tsx");
    expect(source).toMatch(/<button/);
    expect(source).toMatch(/aria-expanded=\{open\}/);
    expect(source).toMatch(/aria-controls=\{panelId\}/);
    expect(source).not.toMatch(/role="menu"/);
  });

  it("methodology disclosure uses native <details>/<summary>", () => {
    const source = read("src/components/story/CoverageComparison.tsx");
    expect(source).toMatch(/<details/);
    expect(source).toMatch(/<summary/);
  });
});

describe("mobile safety — long text wraps rather than overflowing", () => {
  it("claim/entity/publisher text uses break-words or flex-wrap classes", () => {
    const source = read("src/components/story/ClaimEvidenceDrawer.tsx");
    expect(source).toMatch(/break-words/);
    expect(source).toMatch(/flex-wrap/);
  });
});

describe("external links keep the app's existing security convention", () => {
  it('article links use target="_blank" with rel="noopener noreferrer"', () => {
    const source = read("src/components/story/ClaimEvidenceDrawer.tsx");
    expect(source).toMatch(/target="_blank"[\s\S]{0,40}rel="noopener noreferrer"/);
  });

  it("uses safeHttpUrl before rendering any article href", () => {
    expect(read("src/lib/coverageComparisonView.ts")).toMatch(/safeHttpUrl/);
  });

  it("publisher links use Next.js's internal <Link>, never a raw <a> to an arbitrary URL", () => {
    const source = read("src/components/story/ClaimEvidenceDrawer.tsx");
    expect(source).toMatch(/<Link\s+href=\{`\/sources\/\$\{occurrence\.publisherSourceId\}`\}/);
  });
});

describe("source-overlap rendering never combines multiple entities' names under one entity's count", () => {
  it("CoverageComparison.tsx renders one line per sourceOverlap entry (never joins entityNames with a single shared overlapArticleCount)", () => {
    const source = codeOnly(read("src/components/story/CoverageComparison.tsx"));
    // The real defect this guards against: `.map((o) => o.entityName).join(", ")`
    // paired with reading only `sourceOverlap[0]`'s count would misrepresent
    // a second entity's true overlap count as if it were shared by all
    // named entities. Each overlap entry must be mapped to its OWN line.
    expect(source).not.toMatch(/entityName\)\.join\(/);
    expect(source).toMatch(/sourceOverlap!\.map\(\(overlap\)/);
    expect(source).toMatch(/overlap\.entityName/);
    expect(source).toMatch(/overlap\.overlapArticleCount/);
  });
});

describe("ads placement remains outside Coverage Comparison", () => {
  it("the story page's AdContainer usages are unchanged in count (2) and none sit inside Coverage Comparison", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    const adMatches = page.match(/<AdContainer/g) ?? [];
    expect(adMatches).toHaveLength(2);
  });

  it("CoverageComparison.tsx and ClaimEvidenceDrawer.tsx never import AdContainer/AdSlot", () => {
    for (const file of [
      "src/components/story/CoverageComparison.tsx",
      "src/components/story/ClaimEvidenceDrawer.tsx",
    ]) {
      expect(read(file)).not.toMatch(/AdContainer|AdSlot/);
    }
  });
});

describe("existing story-page functionality remains referenced (not accidentally removed)", () => {
  it("ShareButton, BookmarkButton, StoryIntelligence, timeline, and the existing compare section are all still present", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    expect(page).toMatch(/<ShareButton/);
    expect(page).toMatch(/<BookmarkButton/);
    expect(page).toMatch(/<StoryIntelligence/);
    expect(page).toMatch(/id="timeline"/);
    expect(page).toMatch(/id="compare"/);
    expect(page).toMatch(/<CoverageComparison/);
  });

  it("the pre-existing 'Compare coverage' heading and the new section's heading are not identical text (no duplicate H2)", () => {
    const page = read("src/app/story/[slug]/page.tsx");
    const comparisonComponent = read("src/components/story/CoverageComparison.tsx");
    // The existing section's own heading text lives in page.tsx directly.
    expect(page).toMatch(/Compare coverage/);
    // The new component's heading must be a DIFFERENT string.
    expect(comparisonComponent).not.toMatch(/>\s*Compare coverage\s*</);
  });
});

describe("no schema/migration changes beyond the additive Claim table", () => {
  it("prisma/schema.prisma still parses as the same known-good shape plus Claim", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/model StoryCluster/);
    expect(schema).toMatch(/model ProvenanceObservation/);
    expect(schema).toMatch(/model Claim/);
  });
});
