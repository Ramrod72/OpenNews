import { describe, expect, it } from "vitest";
import {
  buildFacebookShareUrl,
  buildLinkedInShareUrl,
  buildRedditShareUrl,
  buildWhatsAppShareUrl,
  buildXShareUrl,
  getStoryUrl,
} from "./share";

const STORY_URL = "https://veriqen.example.com/story/example-story-slug";
const PUBLISHER_URL = "https://some-publisher.example.com/articles/original-report";

describe("getStoryUrl", () => {
  it("builds the canonical Veriqen story URL from a site origin and slug", () => {
    expect(getStoryUrl("example-story-slug", "https://veriqen.example.com")).toBe(STORY_URL);
  });

  it("uses getSiteUrl() by default when no siteUrl is passed", () => {
    // No NEXT_PUBLIC_SITE_URL set in the test environment -> dev fallback.
    expect(getStoryUrl("example-story-slug")).toBe(
      "http://localhost:3000/story/example-story-slug",
    );
  });
});

describe("share URL builders — safe encoding and destination correctness", () => {
  const plainTitle = "Example headline";

  it("X: includes the story url and title, URL-encoded", () => {
    const result = buildXShareUrl({ url: STORY_URL, title: plainTitle });
    expect(result).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?/);
    const params = new URL(result).searchParams;
    expect(params.get("url")).toBe(STORY_URL);
    expect(params.get("text")).toBe(plainTitle);
  });

  it("Facebook: includes only the story url (Facebook's sharer ignores prefilled text)", () => {
    const result = buildFacebookShareUrl({ url: STORY_URL });
    expect(result).toMatch(/^https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?/);
    const params = new URL(result).searchParams;
    expect(params.get("u")).toBe(STORY_URL);
  });

  it("Reddit: includes both the story url and title", () => {
    const result = buildRedditShareUrl({ url: STORY_URL, title: plainTitle });
    expect(result).toMatch(/^https:\/\/www\.reddit\.com\/submit\?/);
    const params = new URL(result).searchParams;
    expect(params.get("url")).toBe(STORY_URL);
    expect(params.get("title")).toBe(plainTitle);
  });

  it("LinkedIn: includes only the story url (share-offsite reads OG tags for the rest)", () => {
    const result = buildLinkedInShareUrl({ url: STORY_URL });
    expect(result).toMatch(/^https:\/\/www\.linkedin\.com\/sharing\/share-offsite\/\?/);
    const params = new URL(result).searchParams;
    expect(params.get("url")).toBe(STORY_URL);
  });

  it("WhatsApp: includes both the title and story url in one text field", () => {
    const result = buildWhatsAppShareUrl({ url: STORY_URL, title: plainTitle });
    expect(result).toMatch(/^https:\/\/wa\.me\/\?/);
    const params = new URL(result).searchParams;
    expect(params.get("text")).toContain(plainTitle);
    expect(params.get("text")).toContain(STORY_URL);
  });
});

describe("special-character / encoding safety", () => {
  const tricky = `Tariffs & "trade wars"? #economy — a story about café résumé 😀`;

  const builders = [
    { name: "X", build: () => buildXShareUrl({ url: STORY_URL, title: tricky }) },
    { name: "Reddit", build: () => buildRedditShareUrl({ url: STORY_URL, title: tricky }) },
    { name: "WhatsApp", build: () => buildWhatsAppShareUrl({ url: STORY_URL, title: tricky }) },
  ];

  for (const { name, build } of builders) {
    it(`${name}: a title with &, ?, #, quotes, apostrophes, unicode, and emoji round-trips exactly through URLSearchParams`, () => {
      const result = build();
      // The raw generated URL string must never contain a literal,
      // un-encoded "&" from the title (which would corrupt the query
      // string) or a literal "#" (which would truncate it as a fragment).
      const [, query] = result.split("?");
      expect(query).toBeDefined();

      const params = new URLSearchParams(query);
      const decodedTitleField = params.get("text") ?? params.get("title") ?? "";
      expect(decodedTitleField).toContain(tricky);
    });
  }

  it("an apostrophe-only title is also encoded safely", () => {
    const title = "It's a story, isn't it?";
    const result = buildXShareUrl({ url: STORY_URL, title });
    const params = new URL(result).searchParams;
    expect(params.get("text")).toBe(title);
  });
});

describe("no publisher/article URL ever appears in a generated share destination", () => {
  const builders = [
    () => buildXShareUrl({ url: STORY_URL, title: "headline" }),
    () => buildFacebookShareUrl({ url: STORY_URL }),
    () => buildRedditShareUrl({ url: STORY_URL, title: "headline" }),
    () => buildLinkedInShareUrl({ url: STORY_URL }),
    () => buildWhatsAppShareUrl({ url: STORY_URL, title: "headline" }),
  ];

  it("every builder's output contains the Veriqen story URL and never the publisher URL, because the builders never receive or reference one", () => {
    for (const build of builders) {
      const result = build();
      expect(result).toContain(encodeURIComponent(STORY_URL));
      expect(result).not.toContain(PUBLISHER_URL);
      expect(result).not.toContain(encodeURIComponent(PUBLISHER_URL));
      expect(result).not.toContain("some-publisher.example.com");
    }
  });
});
