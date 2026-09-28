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
 * Phase 7B is a data-collection foundation only — these are hard product
 * boundaries for its OWN module (see ARCHITECTURE.md's Phase 7 section).
 *
 * Phase 8B has since been built exactly as ARCHITECTURE.md's Phase 8B
 * section describes: a query-time-only, cluster-scoped source-group
 * reasoning layer, living entirely in src/lib/graph/, with NO persisted
 * graph schema. An earlier version of this suite banned the words "source
 * graph"/"provenance graph" appearing anywhere in src/ or worker/, back
 * when Phase 8 was entirely unbuilt and any such mention would have meant
 * scope creep into Phase 7B's own PR. Now that Phase 8B legitimately
 * exists as its own separate, intentionally-scoped module, that blanket
 * word-ban would fail on Phase 8B's own (correct, in-scope) code — the
 * assertions below test the real boundaries instead: Phase 7B's own
 * extraction/persistence module still never grows cross-article reasoning
 * itself, and no phase, ever, persists a source-graph schema.
 */
describe("Phase 7B never computes cross-article independence/reliability claims", () => {
  const FORBIDDEN_CONCEPTS =
    /independent[_\s]?(source|origin)[_\s]?count|corroborat|confirmation[_\s]?count|reliability[_\s]?score|truth[_\s]?score|source[_\s]?graph|provenance[_\s]?graph|provenanceChain|independenceScore/i;

  it("no provenance source file (Phase 7B's own extraction/persistence module) computes an independence/corroboration/reliability/graph concept", () => {
    const offenders = PROVENANCE_SOURCE_FILES.filter((file) =>
      FORBIDDEN_CONCEPTS.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("Phase 7B's own module never grows cross-article/source-graph reasoning itself — that lives only in src/lib/graph/ (Phase 8B)", () => {
    const offenders = PROVENANCE_SOURCE_FILES.filter((file) =>
      /source[_\s]?graph|provenance[_\s]?graph|sharedReportingSource|buildSourceGroups|getClusterOriginSummary/i.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("no phase ever persists a source-graph schema — no InformationOriginGroup/OriginGroupMember/SourceGraphEdge/GraphEdge/ReportingRelationship Prisma model", () => {
    const schemaSource = read("prisma/schema.prisma");
    const FORBIDDEN_PERSISTED_GRAPH_MODEL =
      /model\s+(InformationOriginGroup|OriginGroupMember|SourceGraphEdge|GraphEdge|ReportingRelationship)\b/;
    expect(schemaSource).not.toMatch(FORBIDDEN_PERSISTED_GRAPH_MODEL);
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

/**
 * Phase 8B's source-group/origin-reasoning layer (src/lib/graph/) is an
 * INTERNAL service only — getClusterOriginSummary is called directly by
 * server code, never exposed as a route or rendered anywhere. Phase 9 will
 * eventually call it directly; this suite locks that "not yet" boundary.
 */
describe("Phase 8B exposes no public API and no UI for source-group/origin data", () => {
  it("no API route file exists under /api/graph or /api/provenance", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) => /[\\/]api[\\/](graph|provenance)[\\/]/.test(file));
    expect(offenders).toEqual([]);
  });

  it("no API route file references the graph module", () => {
    const apiFiles = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith(".ts"));
    const offenders = apiFiles.filter((file) =>
      /getClusterOriginSummary|buildSourceGroups|SharedReportingSourceGroup|ClusterOriginSummary/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("no UI component (story/source-facing or admin) references the graph module", () => {
    // Comments are stripped before matching: Phase 9B's StoryIntelligence/
    // EvidenceDrawer components legitimately document (in prose) that they
    // never import these graph-module symbols — a real safety property —
    // and a raw whole-file scan would false-positive on that explanation.
    // The check that matters is unchanged: no UI file's actual CODE may
    // import/reference these symbols directly.
    const uiFiles = [
      ...walk(join(ROOT, "src/components")).filter((f) => f.endsWith(".tsx")),
      ...walk(join(ROOT, "src/app")).filter((f) => f.endsWith(".tsx")),
    ];
    const offenders = uiFiles.filter((file) => {
      const codeOnly = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      return /getClusterOriginSummary|buildSourceGroups|SharedReportingSourceGroup|ClusterOriginSummary/.test(
        codeOnly,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("src/lib/graph/ never imports anything from src/app (no route/UI wiring in the other direction either)", () => {
    const graphFiles = walk(join(ROOT, "src/lib/graph")).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const offenders = graphFiles.filter((file) =>
      /from\s+["']@\/app\//.test(readFileSync(file, "utf8")),
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
