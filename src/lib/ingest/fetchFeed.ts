import Parser from "rss-parser";
import { assertPublicHttpUrl } from "../security/url";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5MB — generous for any legitimate RSS/Atom feed
const USER_AGENT =
  process.env.INGEST_USER_AGENT ??
  "OpenNewsBot/1.0 (+https://github.com/opennews/opennews; self-hosted news aggregator)";

type FeedItem = Parser.Item & {
  "content:encoded"?: string;
  "media:content"?: { $: { url?: string } } | Array<{ $: { url?: string } }>;
  "media:thumbnail"?: { $: { url?: string } };
  enclosure?: { url?: string; type?: string };
};

const parser = new Parser<Record<string, unknown>, FeedItem>({
  timeout: FETCH_TIMEOUT_MS,
  customFields: {
    item: ["media:content", "media:thumbnail", "content:encoded"],
  },
});

export class FeedFetchError extends Error {}

/**
 * Fetches and parses a single feed. Performs an SSRF check on the URL
 * (defense in depth, even though feed URLs are admin-configured), enforces
 * a timeout and a size cap, and never executes anything from the response
 * — it is parsed as XML/text only.
 */
export async function fetchAndParseFeed(feedUrl: string): Promise<Parser.Output<FeedItem>> {
  await assertPublicHttpUrl(feedUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1",
      },
    });

    if (!res.ok) {
      throw new FeedFetchError(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_FEED_BYTES) {
      throw new FeedFetchError(`Feed exceeds ${MAX_FEED_BYTES} byte limit`);
    }

    const text = await readWithLimit(res, MAX_FEED_BYTES);
    return await parser.parseString(text);
  } catch (err) {
    if (err instanceof FeedFetchError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new FeedFetchError(`Timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new FeedFetchError(err instanceof Error ? err.message : "Unknown fetch error");
  } finally {
    clearTimeout(timer);
  }
}

async function readWithLimit(res: Response, limitBytes: number): Promise<string> {
  if (!res.body) return res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new FeedFetchError(`Feed exceeds ${limitBytes} byte limit`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

export function extractImageUrl(item: FeedItem): string | undefined {
  const media = item["media:content"];
  if (Array.isArray(media)) {
    const withUrl = media.find((m) => m?.$?.url);
    if (withUrl?.$?.url) return withUrl.$.url;
  } else if (media?.$?.url) {
    return media.$.url;
  }

  if (item["media:thumbnail"]?.$?.url) return item["media:thumbnail"].$.url;
  if (item.enclosure?.url && item.enclosure.type?.startsWith("image/")) return item.enclosure.url;

  // Fall back to the first <img> found in the HTML content, if any.
  const html = item["content:encoded"] ?? item.content ?? "";
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match?.[1];
}

export type { FeedItem };
