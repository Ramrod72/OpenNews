import { describe, expect, it } from "vitest";
import { excerpt, safeImageUrl, toPlainText } from "./sanitize";

describe("toPlainText", () => {
  it("strips script tags entirely, including their content", () => {
    const result = toPlainText('Hello <script>alert("xss")</script> world');
    expect(result).not.toContain("script");
    expect(result).not.toContain("alert");
    expect(result).toBe("Hello world");
  });

  it("strips all HTML tags", () => {
    const result = toPlainText("<p>Breaking: <b>markets</b> react to <i>news</i></p>");
    expect(result).toBe("Breaking: markets react to news");
  });

  it("removes inline event handlers and dangerous attributes along with their tags", () => {
    const result = toPlainText('<img src=x onerror="alert(1)"> caption text');
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("alert");
  });

  it("decodes common entities and collapses whitespace", () => {
    expect(toPlainText("Q&amp;A   session\n\nwraps up")).toBe("Q&A session wraps up");
  });

  it("returns an empty string for nullish input", () => {
    expect(toPlainText(undefined)).toBe("");
    expect(toPlainText(null)).toBe("");
  });

  it("strips non-whitespace control characters (NUL and other C0/C1 codes), which are otherwise stored verbatim and can break a Postgres TEXT column", () => {
    expect(toPlainText("before\u0000after")).toBe("beforeafter");
    expect(toPlainText("a\u0001\u0007\u001fb\u007f\u009fc")).toBe("abc");
  });

  it("still collapses ordinary whitespace (tab/newline/CR) into a single space, not stripping it", () => {
    expect(toPlainText("a\tb\nc\r\nd")).toBe("a b c d");
  });
});

describe("excerpt", () => {
  it("truncates on a word boundary and adds an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const result = excerpt(long, 50);
    expect(result.length).toBeLessThanOrEqual(51);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched", () => {
    expect(excerpt("Short text.", 220)).toBe("Short text.");
  });
});

describe("safeImageUrl", () => {
  it("allows http/https URLs", () => {
    expect(safeImageUrl("https://example.com/image.jpg")).toBe("https://example.com/image.jpg");
  });

  it("rejects javascript: URLs", () => {
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(safeImageUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(safeImageUrl("not a url")).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
  });
});
