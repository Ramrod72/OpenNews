import type { Article, Source } from "@prisma/client";

export interface SummarizableCluster {
  headline: string;
  articles: Array<Article & { source: Source }>;
}

/**
 * Zero-dependency, zero-cost fallback summarizer. It never invents
 * information — it only selects and lightly stitches together text the
 * feeds themselves already provided (source names + the earliest available
 * excerpt), so it is safe to run with no AI provider configured at all.
 */
export function extractiveSummary(cluster: SummarizableCluster): string {
  const { articles } = cluster;
  if (articles.length === 0) return "";

  const sourceNames = Array.from(new Set(articles.map((a) => a.source.name)));
  const leadArticle = articles.find((a) => a.excerpt && a.excerpt.length > 40) ?? articles[0];

  const parts: string[] = [];

  if (sourceNames.length > 1) {
    const shown = sourceNames.slice(0, 3).join(", ");
    const rest = sourceNames.length > 3 ? ` and ${sourceNames.length - 3} more` : "";
    parts.push(`Covered by ${shown}${rest}.`);
  }

  if (leadArticle?.excerpt) {
    parts.push(leadArticle.excerpt);
  }

  return parts.join(" ").trim();
}
