import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbListJsonLd,
  buildCollectionPageJsonLd,
  buildOrganizationJsonLd,
  buildStoryWebPageJsonLd,
  buildWebSiteJsonLd,
} from "@/lib/seo/structuredData";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("buildStoryWebPageJsonLd never claims Veriqen News authored/published third-party journalism", () => {
  const output = buildStoryWebPageJsonLd({
    headline: "Example headline",
    description: "Example description",
    url: "https://veriqennews.com/story/example",
    sources: [
      { name: "Example Wire Service", homepageUrl: "https://example-wire.example.com" },
      { name: "Example Daily", homepageUrl: null },
    ],
  });

  it("is a WebPage, never a NewsArticle or Article", () => {
    expect(output["@type"]).toBe("WebPage");
  });

  it("never sets author, publisher, or creator at all", () => {
    expect(output).not.toHaveProperty("author");
    expect(output).not.toHaveProperty("publisher");
    expect(output).not.toHaveProperty("creator");
  });

  it("references the underlying publishers only via `mentions`, never as `author`", () => {
    expect(output.mentions).toEqual([
      {
        "@type": "Organization",
        name: "Example Wire Service",
        url: "https://example-wire.example.com",
      },
      { "@type": "Organization", name: "Example Daily" },
    ]);
  });

  it("de-duplicates repeated source names", () => {
    const deduped = buildStoryWebPageJsonLd({
      headline: "Example headline",
      url: "https://veriqennews.com/story/example",
      sources: [
        { name: "Same Source", homepageUrl: null },
        { name: "Same Source", homepageUrl: null },
      ],
    });
    expect(deduped.mentions).toHaveLength(1);
  });
});

describe("buildCollectionPageJsonLd / buildOrganizationJsonLd / buildWebSiteJsonLd stay truthful", () => {
  it("CollectionPage is never typed as a creative-work-authorship schema", () => {
    const output = buildCollectionPageJsonLd({
      name: "Sources",
      url: "https://veriqennews.com/sources",
    });
    expect(output["@type"]).toBe("CollectionPage");
    expect(output).not.toHaveProperty("author");
  });

  it("Organization/WebSite describe Veriqen News itself, not any publisher", () => {
    expect(buildOrganizationJsonLd("https://veriqennews.com").name).toBe("Veriqen News");
    expect(buildWebSiteJsonLd("https://veriqennews.com").name).toBe("Veriqen News");
  });

  it("WebSite's SearchAction points at the real, working /search?q= endpoint", () => {
    const output = buildWebSiteJsonLd("https://veriqennews.com");
    expect(output.potentialAction.target.urlTemplate).toBe(
      "https://veriqennews.com/search?q={search_term_string}",
    );
  });
});

describe("buildBreadcrumbListJsonLd", () => {
  it("preserves item order and position", () => {
    const output = buildBreadcrumbListJsonLd([
      { name: "Home", url: "https://veriqennews.com" },
      { name: "World", url: "https://veriqennews.com/category/world" },
    ]);
    expect(output.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://veriqennews.com" },
      {
        "@type": "ListItem",
        position: 2,
        name: "World",
        item: "https://veriqennews.com/category/world",
      },
    ]);
  });
});

describe("semantic regression: no story-page source ever emits NewsArticle schema", () => {
  // structuredData.ts is deliberately excluded here: its own doc comments
  // explain the rule by naming "NewsArticle" as what's forbidden, which
  // this grep would otherwise flag — buildStoryWebPageJsonLd's actual
  // output is already asserted directly above.
  const STORY_RELATED_FILES = ["src/app/story/[slug]/page.tsx", "src/components/seo/JsonLd.tsx"];

  it("none of the story-page-related source files reference NewsArticle", () => {
    for (const file of STORY_RELATED_FILES) {
      expect(read(file)).not.toMatch(/NewsArticle/);
    }
  });

  it("the story page's JSON-LD call site never sets author/publisher to Veriqen News", () => {
    const source = read("src/app/story/[slug]/page.tsx");
    expect(source).not.toMatch(/author:\s*ORGANIZATION_NAME/);
    expect(source).not.toMatch(/publisher:\s*ORGANIZATION_NAME/);
  });
});
