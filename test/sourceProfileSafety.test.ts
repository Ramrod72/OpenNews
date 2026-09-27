import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const ADMIN_SOURCE_ROUTES = [
  "src/app/api/admin/sources/[id]/route.ts",
  "src/app/api/admin/sources/[id]/assessments/route.ts",
  "src/app/api/admin/sources/[id]/assessments/[assessmentId]/route.ts",
];

describe("every admin source-profile route requires admin auth (and therefore CSRF, via requireAdmin)", () => {
  for (const path of ADMIN_SOURCE_ROUTES) {
    it(`${path} calls requireAdmin(req) before doing anything else`, () => {
      const source = read(path);
      expect(source).toMatch(/requireAdmin\(req\)/);
      expect(source).toMatch(/if\s*\(denied\)\s*return denied;/);
    });
  }
});

describe("the public source-profile route has no admin/session dependency", () => {
  it("src/app/api/sources/[id]/route.ts never imports next/headers or an admin guard", () => {
    const source = read("src/app/api/sources/[id]/route.ts");
    expect(source).not.toMatch(/next\/headers|requireAdmin|getAdminSession/);
  });
});

describe("free-text profile/assessment fields are sanitized with toPlainText before being stored", () => {
  it("PATCH /api/admin/sources/[id] sanitizes description, country, and ownership", () => {
    const source = read("src/app/api/admin/sources/[id]/route.ts");
    expect(source).toMatch(/toPlainText\(description/);
    expect(source).toMatch(/toPlainText\(country/);
    expect(source).toMatch(/toPlainText\(ownership/);
  });

  it("POST assessments route sanitizes provider, ratingValue, ratingScale, and notes", () => {
    const source = read("src/app/api/admin/sources/[id]/assessments/route.ts");
    expect(source).toMatch(/toPlainText\(data\.provider/);
    expect(source).toMatch(/toPlainText\(data\.ratingValue/);
    expect(source).toMatch(/toPlainText\(data\.ratingScale/);
    expect(source).toMatch(/toPlainText\(data\.notes/);
  });

  it("PATCH assessment route sanitizes provider, ratingValue, ratingScale, and notes", () => {
    const source = read("src/app/api/admin/sources/[id]/assessments/[assessmentId]/route.ts");
    expect(source).toMatch(/toPlainText\(data\.provider/);
    expect(source).toMatch(/toPlainText\(data\.ratingValue/);
    expect(source).toMatch(/toPlainText\(data\.ratingScale/);
    expect(source).toMatch(/toPlainText\(data\.notes/);
  });
});

describe("URLs are validated, never accepted as raw strings, for profile/assessment links", () => {
  it("sourceProfileSchema and externalAssessmentSchema both use the http(s)-only httpUrl validator for every URL field", () => {
    const source = read("src/lib/validation/sourceProfile.ts");
    expect(source).toMatch(/homepageUrl:\s*httpUrl/);
    expect(source).toMatch(/logoUrl:\s*httpUrl/);
    expect(source).toMatch(/referenceUrl:\s*httpUrl/);
    expect(source).toMatch(/\/\^https\?:\\\/\\\//i);
  });
});

describe("no unsafe HTML rendering was introduced anywhere in the source-profile feature", () => {
  const files = [
    "src/app/sources/[id]/page.tsx",
    "src/app/admin/(protected)/sources/[id]/page.tsx",
    "src/app/admin/(protected)/sources/[id]/SourceProfileManager.tsx",
    "src/app/api/sources/[id]/route.ts",
    "src/app/api/admin/sources/[id]/route.ts",
    "src/app/api/admin/sources/[id]/assessments/route.ts",
    "src/app/api/admin/sources/[id]/assessments/[assessmentId]/route.ts",
    "src/lib/sourceProfile.ts",
  ];

  for (const path of files) {
    it(`${path} never actually uses dangerouslySetInnerHTML (mentioning it in a comment is fine)`, () => {
      expect(read(path)).not.toMatch(/dangerouslySetInnerHTML\s*[:=]/);
    });
  }
});

describe("external assessment references are stored as data (URL string), never as markup", () => {
  it("the assessment card renders referenceUrl only as an <a href> attribute, not interpolated into markup", () => {
    const source = read("src/app/sources/[id]/page.tsx");
    expect(source).toMatch(/href=\{assessment\.referenceUrl\}/);
  });
});

describe("public API response allowlist never leaks admin/internal-only Source fields", () => {
  it("toPublicSourceProfile's returned object never references the feed url, active flag, or ingestion-health fields", () => {
    const source = read("src/lib/sourceProfile.ts");
    const fnMatch = source.match(/export function toPublicSourceProfile[\s\S]*?\n}/);
    expect(fnMatch).not.toBeNull();
    const fn = fnMatch![0];
    expect(fn).not.toMatch(/\bsource\.url\b/);
    expect(fn).not.toMatch(/\bsource\.active\b/);
    expect(fn).not.toMatch(
      /fetchIntervalMinutes|lastFetchedAt|lastSuccessAt|lastErrorAt|lastError|consecutiveFailures/,
    );
  });
});

describe("cross-source assessment tampering is prevented", () => {
  it("PATCH and DELETE for an assessment scope the lookup by both assessmentId AND sourceId before mutating", () => {
    const source = read("src/app/api/admin/sources/[id]/assessments/[assessmentId]/route.ts");
    const findFirstCalls = [...source.matchAll(/findFirst\(\{\s*where:\s*\{([^}]*)\}/g)];
    expect(findFirstCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of findFirstCalls) {
      expect(call[1]).toMatch(/id:\s*assessmentId/);
      expect(call[1]).toMatch(/sourceId/);
    }
  });
});
