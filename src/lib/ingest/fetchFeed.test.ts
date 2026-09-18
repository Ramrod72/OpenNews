import { describe, expect, it } from "vitest";
import { extractImageUrl, type FeedItem } from "./fetchFeed";

describe("extractImageUrl", () => {
  it("prefers media:content", () => {
    const item: FeedItem = {
      "media:content": { $: { url: "https://example.com/media.jpg" } },
      "media:thumbnail": { $: { url: "https://example.com/thumb.jpg" } },
    };
    expect(extractImageUrl(item)).toBe("https://example.com/media.jpg");
  });

  it("handles media:content as an array", () => {
    const item: FeedItem = {
      "media:content": [
        { $: { url: "https://example.com/a.jpg" } },
        { $: { url: "https://example.com/b.jpg" } },
      ],
    };
    expect(extractImageUrl(item)).toBe("https://example.com/a.jpg");
  });

  it("falls back to media:thumbnail", () => {
    const item: FeedItem = { "media:thumbnail": { $: { url: "https://example.com/thumb.jpg" } } };
    expect(extractImageUrl(item)).toBe("https://example.com/thumb.jpg");
  });

  it("falls back to an image enclosure", () => {
    const item: FeedItem = {
      enclosure: { url: "https://example.com/enc.jpg", type: "image/jpeg" },
    };
    expect(extractImageUrl(item)).toBe("https://example.com/enc.jpg");
  });

  it("ignores a non-image enclosure", () => {
    const item: FeedItem = {
      enclosure: { url: "https://example.com/audio.mp3", type: "audio/mpeg" },
    };
    expect(extractImageUrl(item)).toBeUndefined();
  });

  it("falls back to the first <img> in content:encoded", () => {
    const item: FeedItem = {
      "content:encoded": '<p>Some text <img src="https://example.com/inline.jpg" alt=""></p>',
    };
    expect(extractImageUrl(item)).toBe("https://example.com/inline.jpg");
  });

  it("returns undefined when there is no image signal", () => {
    const item: FeedItem = { title: "No image here" };
    expect(extractImageUrl(item)).toBeUndefined();
  });
});
