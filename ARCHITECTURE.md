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
versa). So `AdContainer` doesn't resolve _anything_ server-side any more —
not even the admin's global/per-slot config. It's a thin, static wrapper
that only tells `AdSlot` which named slot to render; both the admin
config and the viewer decision come from `AdEligibilityProvider`
(mounted once in the root layout), which fetches `GET /api/ads/eligibility`
— a route handler that reads the session cookie, but as its own endpoint
was already fully dynamic/per-request, nothing about it is cached — and
shares the result via context to every `AdSlot`/`AdHeadSnippet` on the
page. This keeps the ISR pages' caching behavior completely unchanged
(confirmed by `npm run build`'s route table still showing `/` etc. as
static with the same revalidate windows) while still making the ad
decision correct per viewer.

That endpoint's response is deliberately asymmetric:
`{ adsAllowed: false }` when the viewer's plan doesn't allow ads, or
`{ adsAllowed: true, settings: AdSettings }` — the actual admin
configuration, every slot's code included — only when it does. This
matters beyond just _rendering_ correctly: an earlier version of this
endpoint returned only the boolean and had `AdContainer` pass the ad
network's raw snippet text down as an ordinary prop regardless of viewer
(needed for the client components to hydrate with it) — which meant a
Basic/Pro browser still _received_ that snippet over the network as part
of the page payload, even though it was confirmed to never execute.
Verified directly: fetching the homepage's raw HTML as a Basic-plan
viewer with `curl` (i.e. before any client JS runs) showed the configured
ad network's URL literally present in the page source. Moving the actual
settings fetch behind the same eligibility gate closes that: an
ineligible viewer's browser now never receives the ad configuration at
all, not just never renders or executes it.

`AdEligibilityProvider`'s `adsAllowed` is `boolean | null` — `null` while
the fetch hasn't resolved yet, and `settings` is `null` until `adsAllowed`
is `true` — and both ad components treat `null` the same as `false`:
nothing renders, not even the placeholder, until eligibility is
confirmed. Optimistically rendering while pending would mean briefly
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

**Privacy.** `/api/ads/eligibility` never returns email, user id, plan
name, subscription id, or anything about the viewer beyond the
`adsAllowed` boolean itself — the `settings` it conditionally includes is
pure admin configuration (ad network snippets, on/off toggles), the same
for every eligible viewer, never templated with anything viewer-specific.
Nothing about a viewer is ever templated into an ad snippet/script before
injection either. No personal information reaches an ad provider through
Veriqen.

## Source profiles and external assessments (Phase 6)

Three deliberately separate concepts, only the first two of which exist yet:

- **Source profile** — descriptive facts about a publisher: type, country,
  ownership, founded year, description, website, logo. Added as new
  nullable columns directly on the existing `Source` model
  (`description`, `sourceType`, `country`, `ownership`, `foundedYear`,
  `profileUpdatedAt`), reusing the pre-existing `homepageUrl`/`logoUrl`
  columns as the profile's "Website"/logo rather than adding redundant
  parallel fields. Every field is optional and every pre-Phase-6 `Source`
  row remains valid with them all `null` — nothing about ingestion,
  clustering, or the existing public `/api/sources` list changes.
- **External source assessment** — a third party's published judgment
  about a source (political lean, factuality, credibility, reliability),
  stored in a new `ExternalAssessment` model
  (`sourceId`, `provider`, `assessmentType`, `ratingValue`, `ratingScale`,
  `referenceUrl`, `assessedAt`, `retrievedAt`, `notes`). `provider` is
  required on every row — there is no way to store an assessment without
  attribution — and the schema intentionally has **no** uniqueness
  constraint on `(sourceId, provider, assessmentType)`, so a source can
  carry multiple assessments of the same type from different providers,
  including ones that disagree. Nothing anywhere averages, merges, or
  otherwise synthesizes a single score across providers; `toPublicSourceProfile()`
  and the `/sources/[id]` page both render every assessment as its own
  record, grouped by type, each showing its own provider.
- **Veriqen article analysis** — article-level framing/language analysis —
  is explicitly **not** built in this phase. Nothing in the schema, API,
  or UI implies Veriqen has an opinion about a source's bias; assessments
  are always presented as "provider X says Y," never as Veriqen's own
  determination.

`sourceType` and `assessmentType` are plain `String` columns validated at
the application layer against a fixed value list
(`src/lib/validation/sourceProfile.ts`'s `SOURCE_TYPE_VALUES`/
`ASSESSMENT_TYPE_VALUES`) — the same no-Prisma-enum convention the schema
already uses for `Subscription.status`, kept for Postgres/SQLite
portability. Extending either list is a one-line change, not a migration.

**Licensing boundary.** No proprietary rating-provider data (AllSides,
Media Bias/Fact Check, Ad Fontes, Ground News, or similar) was scraped,
copied, or seeded anywhere in this phase — the repository contains no
licensing agreement with any such provider. This phase only builds the
framework capable of storing an attributed assessment from any provider;
which provider(s) Veriqen actually licenses and imports data from is a
future decision. Tests and any demonstration data use obviously fictional
provider names ("Example Rating Institute (fictional test provider)",
"Sample Media Observatory (fictional test provider)") that cannot be
mistaken for a real rating.

**API and UI.** `GET /api/sources/[id]` (public, unauthenticated) and the
`/sources/[id]` page both call `getSourceProfile()`
(`src/lib/sourceProfile.ts` — one Prisma query with the assessments
`include`d, no N+1) and serialize through `toPublicSourceProfile()`, an
explicit allowlist that excludes the feed URL and every ingestion-health
field (`active`, `fetchIntervalMinutes`, `lastFetchedAt`, `lastError`,
`consecutiveFailures`, ...) the same way `serializeCluster()` already does
for stories. A profile resolves even for a paused (`active: false`)
source — pausing only affects ingestion, and a story that already links
to a since-paused source shouldn't get a broken profile link. Missing
metadata is always rendered as an explicit "Not listed" rather than
omitted or defaulted to something that reads as real data, and a source
with zero assessments shows an explicit empty state rather than an
empty section.

The story page's "Compare coverage" section links each outlet's name to
its `/sources/[id]` profile — the one Phase 6 integration point into the
existing story UI, deliberately not a full provenance redesign.

Admin editing extends the existing source-management API
(`PATCH /api/admin/sources/[id]`) with the new profile fields, plus two
new nested routes for assessment CRUD
(`POST /api/admin/sources/[id]/assessments`,
`PATCH`/`DELETE /api/admin/sources/[id]/assessments/[assessmentId]`), all
behind the same `requireAdmin()` guard (session + CSRF) every other admin
mutation uses. Every free-text field an admin can enter (description,
country, ownership, provider, rating value/scale, notes) is passed through
`toPlainText()` before being stored — the same "never store or render raw
HTML from user/admin input" rule ingestion already follows for feed
content — even though nothing in this app renders these fields via
`dangerouslySetInnerHTML` in the first place.

## Provenance extraction foundation (Phase 7B)

Veriqen's eventual differentiator is answering "where did this information
actually come from" — distinguishing an article count from a publisher
count from an independent-origin count. Phase 7B builds only the
structured-evidence foundation that later work would need; it does not
attempt any of the cross-article reasoning itself. See the sections below
for the exact boundary.

**Models** (`ProvenanceEntity`, `ProvenanceAlias`, `ProvenanceObservation`,
all additive — no existing column changed): a `ProvenanceEntity` is
something an article's text cites (Reuters, the FBI, a court, an
individual, an anonymous-source concept) — deliberately **separate** from
`Source`, which represents a configured feed Veriqen actively polls. Most
entities an article cites (a wire service, a government agency) are never
configured feeds themselves, and a configured feed is never required to
have a matching entity. `ProvenanceEntity.relatedSourceId` is an optional,
one-directional convenience cross-reference only, for the case where a
cited outlet also happens to be a configured `Source`.

`ProvenanceAlias` maps known surface forms of a name ("Reuters", "Reuters
News", "AP") to one canonical entity, deterministically (`EXACT` or
`CASE_INSENSITIVE` matching, no fuzzy matching). Short, ambiguous
abbreviations ("AP", "DOJ", "FBI") are seeded as `matchType: "EXACT"`
specifically so a lowercase or mixed-case incidental mention ("AP
Chemistry") can never resolve — a bare match still requires the exact
case, and even then the extractor only accepts it when a recognized
attribution verb sits immediately alongside it (see below). SQLite doesn't
support Prisma's `mode: "insensitive"` (the same constraint the Search
section above already documents), so `CASE_INSENSITIVE` resolution
compares against a stored `normalizedAlias` column in application code
rather than a DB-level case-insensitive query.

`ProvenanceObservation` is one structured piece of evidence: "this
article's text appears to attribute information to this entity, this way,
with this snippet" — never an aggregate, never a count, never a score.
`relationshipType` (`CITES_WIRE_SERVICE`, `CITES_STATEMENT`, ...) and
`evidenceType` (`STATEMENT`, `COURT_FILING`, `REPORTING_CITATION`, ...) are
deliberately separate fields, not one merged taxonomy — an entity type, an
evidence form, and a reporting relationship are three different concepts
that shouldn't be forced into a single enum. **`evidenceType` describes
reporting distance only, never truth**: a government statement is primary
evidence of what the government _said_, not proof the claim is correct; a
court filing is primary documentary material for what the filing
_alleges_, not proof the allegation is true. Nothing in this phase (or
anywhere it's rendered, since nothing renders it yet — see below) may
imply otherwise.

**Precision policy — locked for this phase**: false negative over false
positive. The extractor itself classifies a match as `HIGH`, `MEDIUM`, or
`LOW`, but `persistObservationsForArticle` (`src/lib/provenance/
persistObservations.ts`) discards `LOW` before any database write —
`ProvenanceObservation.confidence` is never anything but `HIGH` or
`MEDIUM` in this table. A resolved short `EXACT`-matched alias ("AP",
"DOJ", "FBI") is capped at `MEDIUM` even in an otherwise-`HIGH`
construction, since the token itself remains inherently more ambiguous
than a full name; full names resolved case-insensitively keep `HIGH`.

**Extraction insertion point**: per-article, immediately after ingestion —
not during clustering, which has no additional text to analyze that
ingestion doesn't already have. `ORIGINAL_REPORTING_CLAIM` is the one
relationship type requiring extra context: it's only ever asserted when a
named publisher in the text (e.g. "in an interview with The Guardian")
matches the article's _own_ configured `Source.name` — never inferred
from the mere presence of interview/eyewitness language naming some other
outlet, and never from the absence of a wire-service citation (silence is
not evidence of original reporting).

**The critical text-availability design decision**: `Article.excerpt` has
always been capped at 220 characters (see above), but the feed item's own
`contentSnippet`/`summary`/`content`/`content:encoded` field is sanitized
to a fuller ~8000-character plain-text boundary before that final
truncation happens (`src/lib/security/sanitize.ts`'s `toPlainText`, then
`truncatePlainText`). Phase 7B's ingestion integration
(`src/lib/ingest/ingestSource.ts`) runs the deterministic extractor
against that fuller **sanitized-but-not-yet-truncated** text — so
attribution language appearing after character 220 (very common; a feed's
lead sentence often isn't the sourcing clause) is still detected for
newly-ingested articles. That fuller text is **never itself persisted
anywhere** — no new column, no cache, nothing — only the resulting
structured observations and their small, bounded evidence snippets
survive. `ProvenanceObservation.extractionSource` records which text
buffer an observation's offsets refer to (`TITLE`, `FEED_TEXT`, or
`STORED_EXCERPT_BACKFILL`), so this distinction is never blurred.

**Historical articles are honestly limited**: the fuller feed text was
never retained for articles ingested before this phase, and can't be
recovered without re-fetching (which this phase deliberately never does —
see Security below). The explicitly-invoked backfill
(`npm run backfill:provenance`, `worker/backfill-provenance.ts` — never
run automatically by the migration) only ever produces `TITLE` or
`STORED_EXCERPT_BACKFILL` observations from what's actually stored,
resumable via `--after=<articleId>`, bounded-concurrency
(`mapWithConcurrency`, the same primitive `ingestAll.ts` already uses),
and safe to rerun (dedupe via a `dedupeKey` hash of an observation's
identifying fields, the same unique-constraint-based idempotency pattern
`Article.urlHash` already establishes).

**Extractor**: `src/lib/provenance/patterns.ts` + `extract.ts` — pure,
dependency-light, regex-based, no AI/LLM, no new npm package, following
the same shape as `src/lib/nlp/keywords.ts` and `src/lib/perspective.ts`
(conservative, only labeling what the text explicitly signals). A named
wire-service/government-agency match requires resolving against the known
alias table or the candidate is discarded entirely; role-based
constructions ("police said", "according to the study") don't need
resolution, since the fixed phrase itself is the precision guard.
Negation ("Reuters did not report...") and speculation ("Reuters may
report...", "...is expected to report...") immediately preceding the verb
both suppress a match — including inside a quotation, since the guard
checks the words themselves rather than needing separate quote-span
detection. Nested attribution ("AP reported that police said...") is
captured as two independent flat observations, never a fabricated chain.

**Extractor versioning**: a plain `extractorVersion` string
(`"attribution-regex@1"`), bumped whenever the logic changes meaningfully
— no `ExtractionRun` model in this phase. Reprocessing
(`clearStaleObservations`) removes an article's stale-version
extractor-generated rows before re-extracting, but **never** touches a row
whose `reviewState` is `ADMIN_OVERRIDE`, regardless of its version — a
manually-corrected observation survives every future reprocessing run.
`reviewState` (`UNREVIEWED`/`ADMIN_OVERRIDE`/`DISMISSED`) and
`ProvenanceEntity.mergedIntoId`/`ProvenanceAlias.source` are the only
manual-correction foundation this phase adds — no admin UI, no correction
API; they exist purely so a future one doesn't require a non-additive
migration.

**Security**: zero new outbound network fetches. The extractor operates
entirely on text already available through the existing ingestion
process — it never fetches a publisher's article page, never follows a
link inside an article, and never refetches a historical feed to
reconstruct missing content. `src/lib/security/url.ts`'s `assertPublicHttpUrl`
(the SSRF guard) is untouched. Following article links was considered and
rejected for this phase: those URLs are, by this project's own threat
model, untrusted third-party input (unlike admin-configured feed URLs),
and fetching thousands of them would be a materially larger, higher-
frequency attack surface than the existing one-feed-URL-per-source-per-
interval pattern the SSRF guard was built and tested against.

**Performance**: per-article extraction is pure regex/string matching over
at most ~8000 characters — comparable in cost to the existing
`extractKeywordPhrases` call that already runs per-article at ingestion.
The alias table is loaded once per source fetch (`persistItems`) and once
per backfill run, never once per regex match, keeping alias resolution a
handful of in-memory Map lookups rather than a database query per
candidate.

**Explicitly not in this phase** (see "Phase 8" wherever it's mentioned
above): no independent-source or corroboration count, no source graph, no
reliability/truth score, no admin UI, no public API exposing observations,
no AI-based extraction. Phase 7B produces raw structured evidence only;
reasoning across articles/clusters is Phase 8's job.

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
