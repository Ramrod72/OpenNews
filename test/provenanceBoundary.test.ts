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

const PROVENANCE_SOURCE_FILES = [
  ...walk(join(ROOT, "src/lib/provenance")).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  ),
  join(ROOT, "worker/backfill-provenance.ts"),
];

/**
 * Phase 7B is a data-collection foundation only. These are hard product
 * boundaries (see ARCHITECTURE.md's Phase 7 section) — Phase 8 (the
 * source graph) is explicitly out of scope, not just deprioritized.
 */
describe("Phase 7B never computes cross-article independence/reliability claims", () => {
  const FORBIDDEN_CONCEPTS =
    /independent[_\s]?(source|origin)[_\s]?count|corroborat|confirmation[_\s]?count|reliability[_\s]?score|truth[_\s]?score|source[_\s]?graph|provenance[_\s]?graph|provenanceChain|independenceScore/i;

  it("no provenance source file computes an independence/corroboration/reliability/graph concept", () => {
    const offenders = PROVENANCE_SOURCE_FILES.filter((file) =>
      FORBIDDEN_CONCEPTS.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no code anywhere in src/ or worker/ builds a cross-article/cross-cluster provenance graph", () => {
    const allFiles = [
      ...walk(join(ROOT, "src")).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")),
      ...walk(join(ROOT, "worker")).filter((f) => f.endsWith(".ts")),
    ];
    const offenders = allFiles.filter((file) =>
      /source[_\s]?graph|provenance[_\s]?graph/i.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("Phase 7B exposes no public API and no admin UI for provenance data", () => {
  it("scans every API route file (sanity check the scan itself found real files)", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    expect(apiFiles.length).toBeGreaterThan(5);
  });

  it("no API route reads or exposes ProvenanceObservation/ProvenanceEntity/ProvenanceAlias", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /provenanceObservation|provenanceEntity|provenanceAlias/i.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no admin page/route references provenance data", () => {
    const adminFiles = [
      ...walk(join(ROOT, "src/app/admin")).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")),
      ...walk(join(ROOT, "src/app/api/admin")).filter((f) => f.endsWith(".ts")),
    ];
    const offenders = adminFiles.filter((file) =>
      /provenanceObservation|provenanceEntity|provenanceAlias/i.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no story/source-facing UI component renders provenance data (Phase 9's job, not Phase 7B's)", () => {
    const uiFiles = [
      ...walk(join(ROOT, "src/components")).filter((f) => f.endsWith(".tsx")),
      ...walk(join(ROOT, "src/app")).filter((f) => f.endsWith(".tsx") && !f.includes("/api/")),
    ];
    const offenders = uiFiles.filter((file) =>
      /provenanceObservation|ProvenanceEntity|ProvenanceAlias/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("Phase 7B introduces zero new outbound network fetching", () => {
  it("no provenance module (extraction, resolution, persistence, backfill) calls fetch()", () => {
    const offenders = PROVENANCE_SOURCE_FILES.filter((file) =>
      /\bfetch\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no provenance module imports assertPublicHttpUrl or otherwise touches the SSRF guard — it has nothing to fetch", () => {
    const offenders = PROVENANCE_SOURCE_FILES.filter((file) =>
      /assertPublicHttpUrl/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("ingestSource.ts's SSRF-guarded fetch call count is unchanged by the provenance integration (still exactly the one feed fetch)", () => {
    const fetchFeedSource = read("src/lib/ingest/fetchFeed.ts");
    const matches = fetchFeedSource.match(/\bfetch\s*\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("evidence retention stays bounded — no full feed/article text is persisted", () => {
  it("persistObservations.ts never writes a field storing unbounded raw text (only bounded evidenceText)", () => {
    const source = read("src/lib/provenance/persistObservations.ts");
    expect(source).not.toMatch(/sanitizedFeedText\s*:/); // never assigned to a Prisma field
    expect(source).toMatch(/MAX_EVIDENCE_TEXT_LENGTH/);
  });

  it("ingestSource.ts only ever passes sanitizedFeedText through truncatePlainText() before storage — never assigns the untruncated variable directly to a field", () => {
    const source = read("src/lib/ingest/ingestSource.ts");
    const articleCreateBlock = source.match(/prisma\.article\.create\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(articleCreateBlock).toMatch(/truncatePlainText\(sanitizedFeedText\)/);
    // A bare, unwrapped assignment like `excerpt: sanitizedFeedText,` would
    // store the full untruncated text — the only acceptable appearance is
    // wrapped in truncatePlainText(...).
    expect(articleCreateBlock).not.toMatch(/:\s*sanitizedFeedText\s*[,}]/);
  });
});
