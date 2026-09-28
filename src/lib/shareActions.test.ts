import { describe, expect, it, vi } from "vitest";
import { copyStoryLink, shareViaNativeShare } from "./shareActions";

const STORY_URL = "https://veriqen.example.com/story/example-story-slug";

describe("copyStoryLink", () => {
  it("copies the Veriqen story url to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyStoryLink(STORY_URL, { writeText });
    expect(result).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith(STORY_URL);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("reports failure (not a thrown exception) when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    const result = await copyStoryLink(STORY_URL, { writeText });
    expect(result).toEqual({ ok: false });
  });

  it("reports failure when no clipboard is available at all (unsupported browser)", async () => {
    const result = await copyStoryLink(STORY_URL, undefined);
    expect(result).toEqual({ ok: false });
  });

  it("reports failure for a null clipboard without throwing", async () => {
    await expect(copyStoryLink(STORY_URL, null)).resolves.toEqual({ ok: false });
  });
});

describe("shareViaNativeShare", () => {
  const payload = { title: "Example headline", url: STORY_URL };

  it("passes exactly the story title and Veriqen story url to navigator.share", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const result = await shareViaNativeShare(payload, { share });
    expect(share).toHaveBeenCalledWith({ title: "Example headline", url: STORY_URL });
    expect(result).toEqual({ shared: true, cancelled: false, unsupported: false });
  });

  it("treats an AbortError (user cancelled the native share sheet) as a graceful non-error", async () => {
    const abortError = new DOMException("The user aborted a request.", "AbortError");
    const share = vi.fn().mockRejectedValue(abortError);
    const result = await shareViaNativeShare(payload, { share });
    expect(result).toEqual({ shared: false, cancelled: true, unsupported: false });
  });

  it("treats a genuine failure differently from a cancellation", async () => {
    const share = vi.fn().mockRejectedValue(new Error("some other failure"));
    const result = await shareViaNativeShare(payload, { share });
    expect(result).toEqual({ shared: false, cancelled: false, unsupported: false });
  });

  it("reports unsupported (not an error) when navigator.share doesn't exist", async () => {
    const result = await shareViaNativeShare(payload, undefined);
    expect(result).toEqual({ shared: false, cancelled: false, unsupported: true });
  });

  it("never throws, even when passed null", async () => {
    await expect(shareViaNativeShare(payload, null)).resolves.toEqual({
      shared: false,
      cancelled: false,
      unsupported: true,
    });
  });
});
