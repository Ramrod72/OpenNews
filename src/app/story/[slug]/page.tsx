import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { ExternalLink, Clock, Layers, Sparkles } from "lucide-react";
import { getStoryClusterBySlug, getRelatedClusters } from "@/lib/stories";
import { relativeTime, absoluteTime, shortTime } from "@/lib/format";
import { getStoryUrl } from "@/lib/share";
import { safeHttpUrl } from "@/lib/security/sanitize";
import {
  classifyPerspective,
  PERSPECTIVE_DESCRIPTIONS,
  PERSPECTIVE_LABELS,
  type Perspective,
} from "@/lib/perspective";
import { loadStoryIntelligence, resolveStoryIntelligenceViewerId } from "@/lib/storyIntelligence";
import { loadCoverageComparison } from "@/lib/coverageComparison";
import { loadAiStoryBrief } from "@/lib/aiStoryBrief";
import { BreakingBadge, CategoryBadge } from "@/components/ui/CategoryBadge";
import { BookmarkButton } from "@/components/story/BookmarkButton";
import { ShareButton } from "@/components/story/ShareButton";
import { StoryCard } from "@/components/story/StoryCard";
import { StoryIntelligence } from "@/components/story/StoryIntelligence";
import { CoverageComparison } from "@/components/story/CoverageComparison";
import { AiStoryBrief } from "@/components/story/AiStoryBrief";
import { AdContainer } from "@/components/ads/AdContainer";

export const revalidate = 60;

/**
 * Article.url is untrusted (ultimately from a publisher's RSS feed), and
 * normalizeUrl() (src/lib/ingest/normalize.ts) only canonicalizes a URL —
 * it does not restrict its scheme, so a malicious/compromised feed could
 * in principle supply a javascript:/data: link. Every external article
 * link on this page goes through safeHttpUrl (the same http(s)-only
 * convention Phase 9B's EvidenceDrawer already established) before it's
 * ever used as an href; an unsafe scheme renders the title as plain,
 * non-clickable text instead.
 */
function ArticleTitleLink({
  article,
  className,
}: {
  article: { url: string; title: string };
  className: string;
}) {
  const safeUrl = safeHttpUrl(article.url);
  if (!safeUrl) {
    return <span className={className}>{article.title}</span>;
  }
  return (
    <a href={safeUrl} target="_blank" rel="noopener noreferrer" className={className}>
      {article.title}
    </a>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const cluster = await getStoryClusterBySlug(slug);
  if (!cluster) return { title: "Story not found" };

  // Never fabricate a description when there's no useful summary — an
  // empty/whitespace-only summary is treated the same as none at all,
  // for the plain description and for Open Graph/Twitter alike.
  const description = cluster.summary?.trim() ? cluster.summary : undefined;
  const url = getStoryUrl(cluster.slug);
  const images = cluster.imageUrl ? [cluster.imageUrl] : undefined;

  return {
    title: cluster.headline,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: cluster.headline,
      description,
      url,
      type: "article",
      images,
    },
    twitter: {
      card: cluster.imageUrl ? "summary_large_image" : "summary",
      title: cluster.headline,
      description,
      images,
    },
  };
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cluster = await getStoryClusterBySlug(slug);
  if (!cluster) notFound();

  const storyUrl = getStoryUrl(cluster.slug);
  // All three depend only on `cluster` (or nothing), never on each other,
  // so they run together. resolveStoryIntelligenceViewerId fails safely
  // to anonymous on error; loadStoryIntelligence/loadCoverageComparison
  // each isolate their own failures (see src/lib/storyIntelligence.ts and
  // src/lib/coverageComparison.ts) — none of the three can take down the
  // rest of the page. The same viewerId is reused for Coverage Comparison
  // (Phase 10B) — resolving the current viewer is a generic concern, not
  // specific to Story Intelligence, despite the function's name.
  const [related, viewerId] = await Promise.all([
    getRelatedClusters(cluster, 6),
    resolveStoryIntelligenceViewerId(),
  ]);
  const [storyIntelligence, coverageComparison] = await Promise.all([
    loadStoryIntelligence(cluster, viewerId),
    loadCoverageComparison(cluster, viewerId),
  ]);
  // Depends on the two results above (its AI input is built exclusively
  // from them — see src/lib/ai/storyBrief/input.ts) so it runs after,
  // never in parallel with them. Isolated in its own try/catch inside
  // loadAiStoryBrief; a failure here can never affect Story Intelligence
  // or Coverage Comparison, which have already resolved by this point.
  const aiStoryBrief = await loadAiStoryBrief(
    cluster,
    viewerId,
    coverageComparison,
    storyIntelligence,
  );
  const timeline = [...cluster.articles].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
  const leadArticle = timeline[0];
  const leadArticleUrl = leadArticle ? safeHttpUrl(leadArticle.url) : null;

  const byPerspective = new Map<Perspective, typeof timeline>();
  for (const article of timeline) {
    const p = classifyPerspective(article);
    byPerspective.set(p, [...(byPerspective.get(p) ?? []), article]);
  }

  const bySource = new Map<string, typeof timeline>();
  for (const article of timeline) {
    const key = article.source.id;
    bySource.set(key, [...(bySource.get(key) ?? []), article]);
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
      <article>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {cluster.breaking && <BreakingBadge />}
          {cluster.category && (
            <CategoryBadge slug={cluster.category.slug} name={cluster.category.name} />
          )}
        </div>

        <h1 className="text-3xl leading-tight font-extrabold tracking-tight text-balance sm:text-4xl">
          {cluster.headline}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground-muted">
          <span title={absoluteTime(cluster.firstSeenAt)}>
            First reported {relativeTime(cluster.firstSeenAt)}
          </span>
          <span aria-hidden>·</span>
          <span title={absoluteTime(cluster.lastUpdatedAt)}>
            Updated {relativeTime(cluster.lastUpdatedAt)}
          </span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1">
            <Layers size={13} /> {cluster.sourceCount} source{cluster.sourceCount === 1 ? "" : "s"}
          </span>
        </div>

        {cluster.imageUrl && (
          <div className="relative mt-5 aspect-[16/9] w-full overflow-hidden rounded-xl bg-surface-muted">
            <Image
              src={cluster.imageUrl}
              alt=""
              fill
              sizes="(min-width: 1024px) 700px, 100vw"
              className="object-cover"
              unoptimized
            />
          </div>
        )}

        {cluster.summary && (
          <div className="mt-6 rounded-xl border border-border bg-surface-muted p-4">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-foreground-muted uppercase">
              <Sparkles size={13} /> Automated summary
            </p>
            <p className="text-base leading-relaxed">{cluster.summary}</p>
            <p className="mt-2 text-xs text-foreground-muted">
              Generated from the headlines and excerpts collected below — not written by the
              original publishers, and not a substitute for reading the source articles.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {leadArticle && leadArticleUrl && (
            <a
              href={leadArticleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground"
            >
              Read source <ExternalLink size={14} />
            </a>
          )}
          <a
            href="#timeline"
            className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted"
          >
            Timeline
          </a>
          <a
            href="#compare"
            className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted"
          >
            Compare sources
          </a>
          <a
            href="#trace-this-story-heading"
            className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted"
          >
            Trace this story
          </a>
          <BookmarkButton
            slug={cluster.slug}
            headline={cluster.headline}
            categorySlug={cluster.category?.slug ?? null}
            categoryName={cluster.category?.name ?? null}
            imageUrl={cluster.imageUrl}
          />
          <ShareButton url={storyUrl} title={cluster.headline} />
        </div>

        <StoryIntelligence intelligence={storyIntelligence} />

        <CoverageComparison comparison={coverageComparison} />

        <AiStoryBrief result={aiStoryBrief} />

        {byPerspective.size > 1 && (
          <section className="mt-10">
            <h2 className="mb-3 text-lg font-bold">Perspectives in this coverage</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {(["reporting", "analysis", "opinion"] as Perspective[])
                .filter((p) => byPerspective.has(p))
                .map((p) => (
                  <div key={p} className="rounded-xl border border-border p-4">
                    <p className="font-semibold">{PERSPECTIVE_LABELS[p]}</p>
                    <p className="mt-1 mb-3 text-xs text-foreground-muted">
                      {PERSPECTIVE_DESCRIPTIONS[p]}
                    </p>
                    <ul className="space-y-2">
                      {byPerspective.get(p)!.map((a) => (
                        <li key={a.id}>
                          <ArticleTitleLink
                            article={a}
                            className="text-sm font-medium hover:text-accent hover:underline"
                          />
                          <p className="text-xs text-foreground-muted">{a.source.name}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          </section>
        )}

        <section id="timeline" className="mt-10 scroll-mt-20">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
            <Clock size={17} /> Timeline
          </h2>
          <ol className="relative border-l border-border pl-6">
            {timeline.map((a) => (
              <li key={a.id} className="mb-6 last:mb-0">
                <span
                  className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-accent"
                  aria-hidden
                />
                <time
                  dateTime={a.publishedAt.toISOString()}
                  title={absoluteTime(a.publishedAt)}
                  className="block text-xs font-semibold text-foreground-muted"
                >
                  {shortTime(a.publishedAt)} — {a.source.name}
                </time>
                <ArticleTitleLink
                  article={a}
                  className="mt-0.5 block font-semibold hover:text-accent hover:underline"
                />
                {a.excerpt && <p className="mt-1 text-sm text-foreground-muted">{a.excerpt}</p>}
              </li>
            ))}
          </ol>
        </section>

        <section id="compare" className="mt-10 scroll-mt-20">
          <h2 className="mb-1 text-lg font-bold">Compare coverage</h2>
          <p className="mb-4 text-sm text-foreground-muted">
            How each outlet is reporting this story — headlines, timing, and details side by side.
            Veriqen doesn&apos;t rank or endorse any source; use this to compare framing yourself.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from(bySource.values()).map((articles) => {
              const source = articles[0].source;
              return (
                <div key={source.id} className="rounded-xl border border-border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <Link
                      href={`/sources/${source.id}`}
                      className="font-bold hover:text-accent hover:underline"
                    >
                      {source.name}
                    </Link>
                    {source.homepageUrl && (
                      <a
                        href={source.homepageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent hover:underline"
                      >
                        Visit site
                      </a>
                    )}
                  </div>
                  <ul className="space-y-3">
                    {articles.map((a) => (
                      <li key={a.id}>
                        <ArticleTitleLink
                          article={a}
                          className="text-sm font-semibold hover:text-accent hover:underline"
                        />
                        <p className="text-xs text-foreground-muted">
                          {absoluteTime(a.publishedAt)}
                        </p>
                        {a.excerpt && (
                          <p className="mt-1 line-clamp-2 text-xs text-foreground-muted">
                            {a.excerpt}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        <div className="mt-10">
          <AdContainer slot="articlePage" />
        </div>

        {related.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-lg font-bold">Related stories</h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {related.map((r) => (
                <StoryCard key={r.id} cluster={r} />
              ))}
            </div>
          </section>
        )}
      </article>

      <aside className="hidden lg:block">
        <div className="sticky top-20 flex flex-col gap-4">
          <AdContainer slot="sidebar" />
          <div className="rounded-xl border border-border p-4">
            <p className="mb-2 text-sm font-bold">Sources in this story</p>
            <ul className="space-y-1.5 text-sm">
              {Array.from(bySource.values()).map((articles) => (
                <li key={articles[0].source.id}>
                  <Link
                    href={`/search?source=${articles[0].source.id}`}
                    className="hover:text-accent hover:underline"
                  >
                    {articles[0].source.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    </div>
  );
}
