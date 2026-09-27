# Architecture

## Overview

Veriqen is a single Next.js (App Router) application plus one extra
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
(`src/lib/hooks/usePersonalization.ts`). That local layer is unrelated to
the consumer account system below; migrating it into a synced,
account-backed equivalent (`SavedStory`, `UserTopic`,
`NotificationPreference` already exist in the schema for this) is a
natural next step but hasn't been wired up yet.

Consumer accounts add: **User** / **AuthSession** (session tokens, see
below) / **Plan** / **Entitlement** (the Free/Basic/Pro feature matrix,
seeded from `config/plans.json`) / **Subscription** (a user's current plan)
/ **UsageRecord** (per-user, per-feature, per-calendar-month counters for
quota-limited features).

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

## Consumer accounts (`src/lib/auth/consumer/`, `src/lib/entitlements.ts`)

Deliberately **separate** from admin auth end to end: its own cookie
(`veriqen_session`, vs. admin's `opennews_admin_session`), its own CSRF
header (`x-veriqen-account: 1`, vs. admin's `x-opennews-admin: 1`), and its
own session mechanism — a random 256-bit token handed to the browser in an
`httpOnly` cookie, with only its SHA-256 hash stored server-side
(`AuthSession.tokenHash`). That's a deliberate departure from admin's
`iron-session` encrypted-cookie approach: DB-backed tokens can be revoked
server-side (logout actually invalidates the token — an encrypted cookie
can't be un-decrypted), and every session row records enough
(`userAgent`, `ipAddress`, `lastUsedAt`) to eventually support a "sign out
of other devices" feature.

The logic is split the same way ingestion/clustering are: pure, testable
Prisma code (`session.ts`'s `createSession`/`resolveSessionUser`/
`revokeSession`, `service.ts`'s `registerUser`/`loginUser`) with no
dependency on Next's request-scoped `cookies()`, versus a thin
`next/headers`-touching wrapper (`getCurrentUser.ts`) that only glues the
former to the current request. This is the same shape admin auth has, but
admin's core check (`verifyAdminPassword`) had no tests before this work —
consumer auth's core functions are covered directly (`test/consumerAuth.integration.test.ts`)
precisely because they don't require mocking `next/headers` to reach.

`/account` is gated the same way `/admin` is, and for the same underlying
reason (see below): in `src/proxy.ts`, not only inside the page. The page
also keeps its own `redirect()` check as defense in depth, but middleware
is what guarantees a real HTTP redirect rather than a 200 with a
client-side/meta-refresh fallback — see SECURITY.md for the specific
finding.

**Entitlements** (`src/lib/entitlements.ts`) are resolved from one place:
`getPlan(userId)` (Free for `userId = null`, i.e. anonymous visitors are
Free users for every public feature), `can(userId, feature)` for
boolean gates, `getLimit`/`checkUsage`/`recordUsage` for quota-limited
features (calendar-month buckets). Call sites are meant to use these
rather than inspecting a plan slug directly, so every feature's rule lives
in one seedable table (`config/plans.json` → `prisma/seedPlans.ts`)
instead of scattered `user.plan === "pro"` checks. An unrecognized feature
key resolves to "no access" (fails closed), not "unlimited."

## Pricing UI (`src/lib/pricingContent.ts`, `src/lib/pricing.ts`, `/pricing`)

The `/pricing` page and the account page's plan summary both read from
the same two layers, and neither hardcodes a plan's price, limits, or
feature set:

- `src/lib/pricing.ts` — DB-aware (`getPricingView`, `getAccountPlanSummary`),
  reading plans/entitlements straight from Prisma and resolving the current
  user's plan via `getPlan()` (Phase 3's entitlements module), never a
  scattered `user.plan === "pro"` check. No `next/headers` import, so —
  like `entitlements.ts` and consumer auth's `session.ts` — it's testable
  against a real database with no request-scope mocking.
- `src/lib/pricingContent.ts` — pure marketing copy, keyed by entitlement
  feature key: a label and a `"live" | "planned"` status per feature. It
  never asserts whether a plan _has_ a feature (that's always the real
  `boolValue`/`limitValue` passed in); it only supplies how to describe it
  and whether the underlying product feature actually exists yet. Since
  almost none of Basic/Pro's differentiators are wired into live app
  behavior yet (no page currently calls `can()`/`checkUsage()` for them —
  see the Consumer accounts section above), most of what these two plans
  list is honestly tagged "Coming soon" in the UI rather than implied to
  already work.
- A plan's card only shows what's _new_ since the next-cheapest plan
  (`buildNewHighlights`, a diff over each entry's resolved label between
  two plans' entitlement maps) under an "Everything in Free/Basic, plus:"
  header, so upgrading isn't a full restatement of the cheaper tier. The
  comparison table (`buildComparisonRows`) instead shows every plan's
  value for every entry side by side.
- No endpoint anywhere lets a client set its own plan — `registerUser`
  (Phase 3) is the only code that ever creates a `Subscription`, and it's
  hardcoded to the Free plan. The account page's `UpgradeButton` never
  calls an API; clicking it only reveals text explaining that billing
  isn't configured, and is shared between `/pricing` and `/account` so
  that message is defined once. `test/pricingNavigationAndSafety.test.ts`
  guards this by scanning `src/app/api` for anything that writes to
  subscription/plan state.

## Ads (`src/components/ads/`)

`AdSlot` is provider-agnostic: with nothing configured it renders a
clearly-labeled placeholder box; once an admin pastes a network's snippet
into **Admin → Settings** and enables it, the component re-creates any
`<script>` tags via the DOM API (setting HTML via `innerHTML` alone doesn't
execute embedded scripts) so the real ad actually loads. The default
Content-Security-Policy (`next.config.ts`) only allows same-origin scripts,
so an admin enabling a real ad network will also need to widen `script-src`
there for that network's domain — documented in the Admin → Settings UI.

**Plan-aware ad gating (Phase 5).** Whether an ad renders at all is
`globalAdsEnabled AND viewerEntitlementAllowsAds` (`shouldRenderAds()` in
`src/components/ads/shouldRenderAds.ts`) — both AdSlot and AdHeadSnippet
compute it the same way, and neither ever compares a plan slug directly;
the viewer half comes from the same centralized `can(userId, "ads_enabled")`
entitlement check used everywhere else (Phase 3), so anonymous visitors
automatically resolve to the Free plan's value.

The tricky part is _where_ that viewer check happens. `AdContainer` is a
server component embedded directly in pages that use ISR
(`homepage`/`category`/`story` all set `revalidate = 60`) — if it read the
viewer's session, the cached HTML generated for whichever visitor happens
to trigger a background regeneration would leak into every other
visitor's page for up to 60 seconds (a Free visitor's request could bake
"show ads" into the shared cache a Pro visitor then receives, or vice
versa). So `AdContainer` still only resolves the admin's global/per-slot
config (viewer-independent, safe to cache) exactly as before Phase 5. The
viewer-specific half is resolved entirely client-side: `AdEligibilityProvider`
(mounted once in the root layout) fetches `GET /api/ads/eligibility` —
which does read the session cookie, but as its own route handler it was
already fully dynamic/per-request, nothing about it is cached — and shares
the resulting boolean via context to every `AdSlot`/`AdHeadSnippet` on the
page. This keeps the ISR pages' caching behavior completely unchanged
(confirmed by `npm run build`'s route table still showing `/` etc. as
static with the same revalidate windows) while still making the ad
decision correct per viewer.

`AdEligibilityProvider`'s value is `boolean | null` — `null` while the
fetch hasn't resolved yet — and both ad components treat `null` the same
as `false`: nothing renders, not even the placeholder, until eligibility
is confirmed. Optimistically rendering while pending would mean briefly
mounting a real ad script before knowing the viewer is a paying
subscriber, which is exactly what the "Basic/Pro never see ads" guarantee
rules out. The cost is a Free/anonymous visitor's ad slot appearing a
beat after the rest of the page (one same-origin fetch) instead of
instantly — a normal, unremarkable delay for lazy-loaded ads.

**Failure behavior.** `resolveViewerAdEligibility()` (`src/lib/ads.ts`)
fails safely in two different directions depending on who's asking: an
anonymous visitor (no session cookie at all — checked directly in
`/api/ads/eligibility` before any database call) keeps normal Free
behavior even if something else is broken, since there's no paid promise
to protect for someone who was never signed in; an authenticated visitor
whose plan can't be resolved (e.g. a database outage) fails **closed** —
no ads — since they might be a paying subscriber and an unexpected error
must never accidentally show them ads. A missing/unrecognized
`ads_enabled` entitlement row behaves the same way, for the same reason
(`can()`'s existing fail-closed default, Phase 3).

**Privacy.** `/api/ads/eligibility` returns only `{ adsAllowed: boolean }`
— never email, user id, plan name, or anything else — and nothing about a
viewer is ever templated into an ad snippet/script before injection. No
personal information reaches an ad provider through Veriqen.

## Known limitations / natural next steps

- Clusters never merge after creation, even if two initially-separate
  clusters turn out to be the same story. Splitting is also not supported.
- Search relevance is computed in memory over a bounded candidate set
  rather than a real full-text index.
- The in-memory rate limiter (`src/lib/rateLimit.ts`) is per-process; it
  resets on restart and isn't shared across multiple app instances behind a
  load balancer.
- Bookmarks/topics/notification-preference personalization is still
  local-only (`localStorage`); the schema (`SavedStory`, `UserTopic`,
  `NotificationPreference`) supports migrating it to the account system,
  but the UI hasn't been wired up to do so yet.
- There's no billing integration yet — the account page's "upgrade" action
  is a placeholder that says billing isn't configured, not a Stripe (or
  similar) checkout flow.
- Expired/revoked `AuthSession` rows aren't pruned by anything — they're
  already inert (`resolveSessionUser` rejects them), just not deleted, so
  the table grows unboundedly. A periodic cleanup (cron or a check on
  write) is a natural addition once session volume makes it worth it.
