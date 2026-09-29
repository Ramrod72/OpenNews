import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "@/lib/security/sanitize";

const PAGE_PATH = join(__dirname, "..", "src/app/story/[slug]/page.tsx");
const read = () => readFileSync(PAGE_PATH, "utf8");

/**
 * Phase 10B prerequisite hardening: every external article link on the
 * story page (Read source, Perspectives, Timeline, Compare coverage) must
 * pass Article.url through safeHttpUrl before it's ever used as an href —
 * Article.url is untrusted feed-supplied data, and normalizeUrl() does not
 * restrict its scheme (javascript:/data: parse without throwing). This
 * closes the same class of gap Phase 9B's EvidenceDrawer.tsx already
 * closed for its own rendering path, applied here to the four pre-existing
 * unguarded story-page rendering paths identified during Phase 10A's
 * read-only audit.
 */
describe("story page never renders an unguarded external article href", () => {
  it("no raw `href={...url}` bypasses ArticleTitleLink/safeHttpUrl", () => {
    const source = read();
    // Every external article-derived href must flow through
    // leadArticleUrl (already-sanitized) or ArticleTitleLink (which
    // internally calls safeHttpUrl) — never a raw `.url` field directly
    // interpolated into an href.
    expect(source).not.toMatch(/href=\{a\.url\}/);
    expect(source).not.toMatch(/href=\{leadArticle\.url\}/);
    expect(source).toMatch(/href=\{leadArticleUrl\}/);
    expect(source).toMatch(/safeHttpUrl\(leadArticle\.url\)/);
  });

  it("defines and uses an ArticleTitleLink helper backed by safeHttpUrl for every article-loop render", () => {
    const source = read();
    expect(source).toMatch(/function ArticleTitleLink/);
    expect(source).toMatch(/const safeUrl = safeHttpUrl\(article\.url\)/);
    // Perspectives, Timeline, and Compare coverage each render one.
    const usages = source.match(/<ArticleTitleLink\b/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(3);
  });

  it("never renders javascript:void(0) as a workaround", () => {
    expect(read()).not.toMatch(/javascript:void\(0\)/);
  });
});

describe("safeHttpUrl (reused by the story page hardening)", () => {
  it("allows plain http(s) article URLs through unchanged", () => {
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects javascript:, data:, file:, and vbscript: schemes", () => {
    expect(safeHttpUrl("javascript:alert(document.cookie)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects malformed URLs without throwing", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  it("rejects a credential-bearing URL (embedded userinfo)", () => {
    expect(safeHttpUrl("https://user:pass@example.com/a")).toBeNull();
    expect(safeHttpUrl("https://trusted-looking@evil.example/a")).toBeNull();
  });

  it("never lets a control-character-laced string produce a javascript: result", () => {
    const result = safeHttpUrl("http://example.com/\u0000\u0001");
    expect(result === null || !result.startsWith("javascript:")).toBe(true);
  });
});
