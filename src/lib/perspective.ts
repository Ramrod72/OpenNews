export type Perspective = "reporting" | "analysis" | "opinion";

const OPINION_PATTERN = /\/(opinion|commentary|editorial|op-ed)(\/|$)/i;
const OPINION_PREFIX = /^(opinion|editorial|op-ed)\s*[:—-]/i;
const ANALYSIS_PATTERN = /\/(analysis|explainer)(\/|$)/i;
const ANALYSIS_PREFIX = /^(analysis|explainer)\s*[:—-]/i;

/**
 * Classifies an article by the URL section path or title prefix a
 * publisher itself used (e.g. `/opinion/`, `"Analysis: ..."`). This is a
 * deliberately conservative heuristic: it only labels something
 * "analysis" or "opinion" when the publisher's own metadata signals it,
 * and defaults everything else to "reporting" rather than guessing —
 * consistent with never fabricating a distinction the data doesn't
 * support.
 */
export function classifyPerspective(article: { url: string; title: string }): Perspective {
  const url = article.url.toLowerCase();
  const title = article.title.trim();

  if (OPINION_PATTERN.test(url) || OPINION_PREFIX.test(title)) return "opinion";
  if (ANALYSIS_PATTERN.test(url) || ANALYSIS_PREFIX.test(title)) return "analysis";
  return "reporting";
}

export const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  reporting: "Factual reporting",
  analysis: "Analysis",
  opinion: "Opinion / commentary",
};

export const PERSPECTIVE_DESCRIPTIONS: Record<Perspective, string> = {
  reporting: "Coverage the publisher categorized as news reporting.",
  analysis:
    "Coverage the publisher labeled as analysis or an explainer — more interpretive than straight reporting.",
  opinion:
    "Coverage the publisher labeled as opinion, commentary, or editorial — reflects the author's viewpoint.",
};
