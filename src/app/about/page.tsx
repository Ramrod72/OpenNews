import type { Metadata } from "next";
import { getSiteUrl } from "@/lib/siteUrl";

export const metadata: Metadata = {
  title: "About",
  description:
    "Veriqen News is an open-source news aggregator that clusters public RSS coverage into stories, with source comparisons and provenance tracing — not an editor or publisher of its own.",
  alternates: { canonical: `${getSiteUrl()}/about` },
};

export default function AboutPage() {
  return (
    <div className="prose prose-sm max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">About Veriqen News</h1>
      <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
        Veriqen News is an open-source news aggregator. It collects headlines, publication times,
        and short excerpts from publicly published RSS/Atom feeds, groups articles that appear to
        cover the same event into a single story, and links back to the original publishers for the
        full article.
      </p>
      <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
        It does not republish full article text, does not bypass paywalls or anti-bot protections,
        and does not use any paid news, search, or AI API by default. Story summaries are generated
        automatically from the collected excerpts (optionally assisted by a self-hosted,
        Ollama-compatible language model if an administrator configures one) — they are not written
        or reviewed by the original publishers.
      </p>
      <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
        The &ldquo;breaking&rdquo; label is only applied when multiple independent sources are
        actively publishing about the same story within a short window — it is a computed signal,
        not an editorial judgment.
      </p>
      <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
        The project is open source; see the repository README for architecture details, self-hosting
        instructions, and how to configure feeds.
      </p>
    </div>
  );
}
