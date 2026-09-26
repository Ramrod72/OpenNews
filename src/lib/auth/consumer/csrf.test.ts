import { describe, expect, it } from "vitest";
import { CSRF_HEADER, hasCsrfHeader } from "./csrf";

describe("consumer CSRF header", () => {
  it("uses a distinct header name from the admin CSRF header", () => {
    expect(CSRF_HEADER).toBe("x-veriqen-account");
  });

  it("is false when the header is missing", () => {
    const req = new Request("https://example.com", { method: "POST" });
    expect(hasCsrfHeader(req)).toBe(false);
  });

  it("is true only when the header is exactly '1'", () => {
    const withHeader = new Request("https://example.com", {
      method: "POST",
      headers: { [CSRF_HEADER]: "1" },
    });
    expect(hasCsrfHeader(withHeader)).toBe(true);

    const wrongValue = new Request("https://example.com", {
      method: "POST",
      headers: { [CSRF_HEADER]: "true" },
    });
    expect(hasCsrfHeader(wrongValue)).toBe(false);
  });
});
