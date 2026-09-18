# Architecture

## Overview

OpenNews is a single Next.js (App Router) application plus one extra
long-running Node process (the **worker**). They share one Prisma-managed
database.

```
                 ┌─────────────────────┐
  RSS/Atom  ───▶ │   worker (node-cron)│
  feeds          │   ingest → cluster   │
                 └──────────┬───────────┘
                            │ writes
                            ▼
                 ┌─────────────────────┐
                 │   SQLite / Postgres  │
                 └──────────┬───────────┘
                            │ reads
                            ▼
                 ┌─────────────────────┐
  Browser  ───▶  │  Next.js app (web)   │
                 │  pages + /api routes │
                 │  + /admin (auth'd)   │
                 └─────────────────────┘
```

The web app never fetches feeds itself — it only reads what the worker has
already ingested and clustered. This keeps page loads fast and means a slow
or failing feed can never block a request.

## Data model (`prisma/schema.prisma`)

- **Source** — one configured feed: URL, category, fetch interval, and
  health fields (`lastSuccessAt`, `consecutiveFailures`, `lastError`, ...).
- **Category** — a topic section (World, Technology, ...).
- **Article** — one item pulled from a feed: title, plain-text excerpt,
  image, publish time, and a `urlHash` used for dedupe. Articles belong to
  exactly one `Source` and (once clustered) one `StoryCluster`.
- **StoryCluster** — a "story": a group of `Article`s believed to cover the
  same event, with a representative headline, an auto-generated summary,
  aggregate `sourceCount`/`articleCount`, and a `breaking` flag/score.
- **Keyword** / **ArticleKeyword** / **ClusterKeyword** — lightweight
  extracted entities/topics (see below), used for search and (eventually)
  topic browsing.
- **FeedFetchLog** — one row per fetch attempt, feeding the Admin → Feed
  health view.
- **AdminSetting** — runtime-configurable settings (ad slots, AI provider)
  set from the admin panel, so changing them doesn't require a redeploy.

Bookmarks, followed/hidden categories, and saved searches are **not** in the
database — they live entirely in the browser's `localStorage`
(`src/lib/hooks/usePersonalization.ts`). There's no account system in this
version; the architecture doesn't preclude adding one later (that local
storage layer would become a cache in front of a synced account).

## Ingestion (`src/lib/ingest/`)

1. `ingestAllDueSources` (`ingestAll.ts`) loads active `Source`s and filters
   to ones whose `fetchIntervalMinutes` has elapsed, then fetches up to 4
   concurrently (`src/lib/concurrency.ts` — a tiny dependency-free worker
   pool).
2. `fetchAndParseFeed` (`fetchFeed.ts`) fetches with a timeout, a byte-size
   cap, and an SSRF guard (`src/lib/security/url.ts`) that resolves the
   hostname and rejects private/loopback/link-local addresses before
   connecting — defense in depth even though feed URLs are admin-configured.
3. `ingestSource.ts` parses items, normalizes each URL (`normalize.ts`
   strips tracking params, lowercases the host, drops the fragment) and
   hashes it for dedupe, reduces all text to plain text
   (`src/lib/security/sanitize.ts` — no HTML is ever stored or rendered from
   a feed), and inserts new `Article` rows. A unique constraint on `urlHash`
   makes exact-duplicate detection a database guarantee, not just
   application logic (see `test/clustering.integration.test.ts`).
4. Every attempt (success or failure) writes a `FeedFetchLog` row and
   updates the `Source`'s health fields, with retries (2 extra attempts,
   1s/3s backoff) before a fetch is recorded as failed.
5. A lightweight heuristic (`src/lib/nlp/keywords.ts`) extracts
   capitalized-phrase "entities" (e.g. "European Union", "NASA") from each
   title and links them via `ArticleKeyword`, powering search relevance and
   (in the cluster) `ClusterKeyword` aggregation.

## Clustering (`src/lib/clustering/`)

There's no clustering microservice or ML model — it's TF-IDF cosine
similarity over titles (weighted 2x) plus a slice of each excerpt, computed
in-process:

1. For each category, load recently-published articles (last 4 days) and
   build TF-IDF vectors over that shared corpus (`tfidf.ts`).
2. Existing clusters with recent members become "attractors": their
   centroid is the average of their members' vectors.
3. Unclustered articles are processed chronologically; each is assigned to
   the highest-similarity attractor above a fixed threshold (0.32), or
   seeds a brand-new cluster otherwise.
4. Once assigned, an article's cluster never changes — this keeps story
   URLs (`/story/[slug]`) stable. Two clusters are never merged after the
   fact in this version (see Known limitations).
5. After clustering, `breaking` is computed from real signal only:
   `sourceCount >= 3` independent sources **and** the story is less than 18
   hours old. There's no other path to that flag.
6. `summarizeCluster` (`src/lib/ai/`) generates the story summary:
   extractive by default (source names + the best available excerpt — never
   invented text), or via an optional Ollama-compatible provider if one is
   configured, with the extractive summary as the fallback on any failure
   or timeout.

## Perspective labeling (`src/lib/perspective.ts`)

Story pages can split coverage into "Factual reporting" / "Analysis" /
"Opinion" sections — but only when the _publisher itself_ signaled it, via a
URL path segment (`/opinion/`, `/analysis/`) or a title prefix
("Opinion: ..."). Everything else defaults to "reporting" rather than
guessing. This is a deliberately conservative heuristic, consistent with
never fabricating a distinction the data doesn't support.

## Search (`src/lib/search.ts`)

SQLite and PostgreSQL disagree on case-insensitive `contains` semantics
(Prisma's `mode: "insensitive"` isn't supported on SQLite), so free-text
relevance is computed in application code: structural filters (category,
source, date range) are pushed down as SQL, then up to 800 matching
candidate clusters are scored in memory (title/summary/excerpt/source-name
matches, weighted, plus a small boost for broader corroboration) and
paginated. This is simple and portable across both databases and plenty
fast at self-hosted-aggregator scale; a database-side full-text index
(SQLite FTS5 or Postgres `tsvector`) is a natural upgrade path if a
deployment outgrows it.

## Admin auth (`src/proxy.ts`, `src/lib/auth/`)

Authentication is a single admin credential (`ADMIN_PASSWORD_HASH`, a bcrypt
hash — or `ADMIN_PASSWORD` plaintext for local dev only), an `iron-session`
cookie, and **middleware-level** gating (`src/proxy.ts`, Next's newer name
for `middleware.ts`).

That last point matters: an earlier version of this app checked
`session.isAdmin` inside the `/admin` route group's layout and called
`redirect()` there. That does **not** work — Next.js renders a layout's
`children` segment in parallel with the layout itself, so the protected
page's real content was still generated and included in the response before
the client ever acted on the redirect (confirmed by inspecting the raw
response during development). Middleware runs before any page/layout code
executes and can issue a genuine HTTP redirect, so it's the only place this
check is actually enforced. Route handlers under `/api/admin/*`
additionally check the session themselves (`src/lib/auth/guard.ts`), since
middleware failing open there would be a second single point of failure.

Mutating admin API requests also require a custom header
(`x-opennews-admin: 1`) as a lightweight CSRF defense: a cross-site form
post can't set custom headers, and a cross-site `fetch` attempt to set one
would trigger a CORS preflight this app never allows.

## Ads (`src/components/ads/`)

`AdSlot` is provider-agnostic: with nothing configured it renders a
clearly-labeled placeholder box; once an admin pastes a network's snippet
into **Admin → Settings** and enables it, the component re-creates any
`<script>` tags via the DOM API (setting HTML via `innerHTML` alone doesn't
execute embedded scripts) so the real ad actually loads. The default
Content-Security-Policy (`next.config.ts`) only allows same-origin scripts,
so an admin enabling a real ad network will also need to widen `script-src`
there for that network's domain — documented in the Admin → Settings UI.

## Known limitations / natural next steps

- Clusters never merge after creation, even if two initially-separate
  clusters turn out to be the same story. Splitting is also not supported.
- Search relevance is computed in memory over a bounded candidate set
  rather than a real full-text index.
- The in-memory rate limiter (`src/lib/rateLimit.ts`) is per-process; it
  resets on restart and isn't shared across multiple app instances behind a
  load balancer.
- There's no account system; personalization is local-only by design (see
  above), but the code is structured so a synced-accounts feature could sit
  behind the same hooks later.
