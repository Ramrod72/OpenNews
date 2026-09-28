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

  it("is a no-op for every real slug shape slugify() actually produces ([a-z0-9-]+)", () => {
    expect(getStoryUrl("markets-react-to-policy-shift-ab12cd", "https://veriqen.example.com")).toBe(
      "https://veriqen.example.com/story/markets-react-to-policy-shift-ab12cd",
    );
  });

  describe("hostile slug input never escapes the /story/ path segment", () => {
    const site = "https://veriqen.example.com";
    const hostileSlugs = [
      "a b",
      "a#b",
      "a?b",
      "a%b",
      `a"b'c`,
      "café-résumé-😀",
      "a/b",
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
    ];

    for (const slug of hostileSlugs) {
      it(`slug ${JSON.stringify(slug)} stays entirely within the path, with no query/fragment/origin escape`, () => {
        const result = getStoryUrl(slug, site);
        const url = new URL(result);
        expect(url.origin).toBe(site);
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        expect(url.pathname.startsWith("/story/")).toBe(true);
        // Decoding the path segment recovers the exact original slug —
        // proof nothing was silently dropped, merged into another
        // component, or left partially unencoded.
        expect(decodeURIComponent(url.pathname.slice("/story/".length))).toBe(slug);
      });
    }
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

  it("a title crafted to look like extra query params (&, =) can never inject a new parameter into X's share URL", () => {
    const injectionTitle = `Normal headline&url=https://evil.example.com&extra=1`;
    const params = new URL(buildXShareUrl({ url: STORY_URL, title: injectionTitle })).searchParams;
    expect([...params.keys()].sort()).toEqual(["text", "url"]);
    expect(params.get("url")).toBe(STORY_URL);
    expect(params.get("text")).toBe(injectionTitle);
  });

  it("a title crafted to look like extra query params can never inject a new parameter into Reddit's share URL", () => {
    const injectionTitle = `Normal headline&url=https://evil.example.com&extra=1`;
    const params = new URL(buildRedditShareUrl({ url: STORY_URL, title: injectionTitle }))
      .searchParams;
    expect([...params.keys()].sort()).toEqual(["title", "url"]);
    expect(params.get("url")).toBe(STORY_URL);
    expect(params.get("title")).toBe(injectionTitle);
  });

  it("a title crafted to look like extra query params can never inject a second url into WhatsApp's single text field", () => {
    const injectionTitle = `Normal headline&url=https://evil.example.com&extra=1`;
    const params = new URL(buildWhatsAppShareUrl({ url: STORY_URL, title: injectionTitle }))
      .searchParams;
    expect([...params.keys()]).toEqual(["text"]);
    expect(params.get("text")).toBe(`${injectionTitle} ${STORY_URL}`);
  });

  it("a title containing = does not create extra query parameters when parsed", () => {
    const title = "50% off? really = yes";
    const result = buildXShareUrl({ url: STORY_URL, title });
    const params = new URL(result).searchParams;
    expect([...params.keys()].sort()).toEqual(["text", "url"]);
    expect(params.get("text")).toBe(title);
  });

  it("a title that is itself a URL is carried as inert text, not treated as a second link", () => {
    const title = "See https://not-veriqen.example.com/fake for details";
    const result = buildRedditShareUrl({ url: STORY_URL, title });
    const params = new URL(result).searchParams;
    expect(params.get("title")).toBe(title);
    expect(params.get("url")).toBe(STORY_URL);
  });

  it("no builder ever double-encodes the story URL (single encoding pass only)", () => {
    for (const result of [
      buildXShareUrl({ url: STORY_URL, title: "t" }),
      buildFacebookShareUrl({ url: STORY_URL }),
      buildRedditShareUrl({ url: STORY_URL, title: "t" }),
      buildLinkedInShareUrl({ url: STORY_URL }),
    ]) {
      // A double-encoded URL would contain a literal "%25" (an encoded
      // "%" from re-encoding the first pass's own "%3A"/"%2F" etc).
      expect(result).not.toContain("%25");
    }
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
