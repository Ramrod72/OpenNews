import { getAiConfig } from "./config";
import { extractiveSummary, type SummarizableCluster } from "./extractive";
import { callOllama } from "./ollama";

export type { SummarizableCluster };

/**
 * Produce a short summary for a story cluster. Always works without any AI
 * provider configured (pure extractive fallback over the excerpts already
 * collected from feeds). If an Ollama-compatible provider is configured,
 * it's tried first and the extractive summary is used if it's unavailable,
 * slow, or returns nothing usable.
 */
export async function summarizeCluster(cluster: SummarizableCluster): Promise<string | null> {
  const extractive = extractiveSummary(cluster);
  const config = await getAiConfig();

  if (config.provider === "ollama" && cluster.articles.length > 0) {
    try {
      const aiText = await callOllama(config, buildPrompt(cluster));
      if (aiText && aiText.length > 20) return aiText;
    } catch (err) {
      console.warn("[ai] provider call failed, using extractive summary:", err);
    }
  }

  return extractive || null;
}

function buildPrompt(cluster: SummarizableCluster): string {
  const items = cluster.articles
    .slice(0, 8)
    .map((a) => `- (${a.source.name}) ${a.title}${a.excerpt ? `: ${a.excerpt}` : ""}`)
    .join("\n");

  return [
    "You are summarizing news coverage for a neutral news aggregator.",
    "Using ONLY the headlines and excerpts below, write a factual 2-3 sentence summary of the story.",
    "Do not invent facts, names, numbers, or quotes that are not present below.",
    "If sources appear to disagree, note that neutrally without taking a side.",
    "",
    `Story: ${cluster.headline}`,
    "",
    "Coverage:",
    items,
  ].join("\n");
}
