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

## Source-group / origin-reasoning foundation (Phase 8B)

Phase 8B is the first cross-article reasoning layer built on top of Phase
7B's raw observations — but it is deliberately narrow: a **query-time-only,
cluster-scoped** grouping of already-persisted evidence, not a general
source graph, not a reliability system, and not claim-level reasoning
(that remains Phase 10's job — see below). Everything lives in
`src/lib/graph/`, callable only as the internal function
`getClusterOriginSummary(prisma, clusterId)` — there is no REST endpoint,
no `/api/graph`, no `/api/provenance`, and no UI reads it yet (a future
Phase 9 will call it directly).

**No persisted graph — locked.** There is no `InformationOriginGroup`, no
`OriginGroupMember`, no `SourceGraphEdge`/`GraphEdge`, no
`ReportingRelationship`, and no migration for any of them. Every
`ClusterOriginSummary` is recomputed from scratch on each call, from
whatever `ProvenanceObservation`/`ProvenanceEntity` rows and `StoryCluster`
membership already exist — cheap, because a single cluster's article count
is always small relative to the whole database. If a future phase's
testing ever demonstrates a genuine performance need for persistence, that
is a decision for that phase to make explicitly and re-justify, not
something Phase 8B backs into quietly.

**Cluster membership is a topic signal, not a provenance signal.**
`StoryCluster` groups articles the clustering engine judged topically
similar (TF-IDF cosine similarity — see above); that is never treated as
evidence of shared origin. All Phase 8B reasoning is scoped to exactly one
cluster at a time — nothing ever compares articles across two different
clusters (regression-tested directly) — purely because a cluster is a
natural, bounded unit of work, not because same-cluster implies
same-origin.

**`SHARED_REPORTING_SOURCE` — the Reuters/AP limitation.** Observations
are grouped by their resolved `ProvenanceEntity`, after dereferencing
`mergedIntoId` (bounded and cycle-safe — see below), within one cluster
only. A group naming Reuters or AP means exactly one thing: **these
articles' text cites the same reporting entity.** It is explicitly,
permanently **not** "same dispatch," **not** "independently confirmed,"
and **not** "same underlying claim" — wire services are cited by many
unrelated outlets as a matter of routine, and this module never upgrades
that to a stronger claim anywhere, under any confidence tier. A resolved
short alias inherits whatever confidence Phase 7B already assigned it
(`ObservationRef.confidence`); the group's own relationship confidence is
a separate field, always `POSSIBLE` for a plain shared citation, never
`CONFIRMED`.

**Near-duplicate excerpt text — `LIKELY_SHARED_TEXT_ORIGIN`.**
`excerptSimilarity.ts` compares `Article.excerpt` (the already-stored,
already-sanitized ~220-character text) using word-level shingles (size 3)
and Jaccard overlap — deterministic, no regex-based fuzzy matching, no NLP
dependency. A pair clearing the similarity floor is exposed as a
`STRONGLY_INFERRED`, explicitly corroborating-only signal, labeled
`LIKELY_SHARED_TEXT_ORIGIN` and carrying a fixed disclaimer note — never
`SAME_REUTERS_DISPATCH`, never `CONFIRMED_SAME_ORIGIN`. Comparison only
ever happens **inside an already-narrowed, single-entity candidate
group** — never across a whole cluster — and is skipped entirely (no
comparison, no signal, no error) once that group exceeds
`MAX_GROUP_SIZE_FOR_TEXT_COMPARISON` (25): a cluster where 1,000 articles
all cite Reuters resolves to one `SHARED_REPORTING_SOURCE` group and zero
pairwise text comparisons, not ~500,000 — a deliberate false-negative-over-
false-positive/performance tradeoff, not an oversight.

**Primary-evidence grouping stays conservative.** Phase 7B's extractor
recognizes only generic phrases for court filings, press releases, and
studies (no docket/document/study identifiers), so two unresolved "court
filing" observations across different articles never become a strong
shared-document group merely because both say "court filing" — that would
be exactly the overclaiming this phase must avoid. `primaryEvidenceGroups`
only groups observations that share **both** a resolved canonical entity
**and** the same `evidenceType`; given Phase 7B's current extractor this
correctly, honestly produces no group today (no primary-evidence
observation currently carries a resolved entity at all — see
`patterns.ts`), the same accepted limitation as `CONFIRMED` never being
auto-generated. Capturing document identifiers is an explicit future
enhancement, out of scope here.

**Generic/anonymous sourcing is never merged across articles.** Role-based
observations with no resolved entity ("police said," "officials said,"
"a person familiar with the matter said," ...) never participate in any
group — regardless of how closely their wording matches across articles.
Matching text for an unresolved, non-specific role is not evidence of a
shared reporting source.

**Original reporting stays per-article.** `ORIGINAL_REPORTING_CLAIM`
observations are surfaced as `originalReportingSignals`, one entry per
observation — never aggregated across articles (originality is a property
of one article/publisher's own text, not a cross-article relationship),
and never turned into a whole-article truth claim or a publisher-quality
score.

**`mergedIntoId` dereferencing is bounded and cycle-safe.**
`resolveCanonicalEntityId` walks a merge chain to find the entity
observations should actually be grouped under, handling — without ever
throwing or looping — a plain chain, a missing merge target (stops and
uses the last resolvable id), a cycle (a visited-set check stops and
returns the id at which the cycle was redetected — two different starting
points inside a broken cycle can resolve to two different "canonical" ids
rather than being incorrectly merged, a deliberate refuse-to-merge-over-
guess choice), and a pathologically long chain (`MAX_MERGE_CHAIN_DEPTH`
bounds the walk). It never mutates a `ProvenanceEntity` row.

**Multiple metrics, never one score.** `ClusterOriginSummary` exposes
`articleCount`, `publisherCount`, `sharedReportingSourceGroups`,
`primaryEvidenceGroups`, `originalReportingSignals`,
`unresolvedArticleCount`, and `provenanceCoverage` as separate, factual,
fully-traceable fields. There is no `independentOriginCount`,
`originScore`, `reliabilityScore`, `truthScore`, or `corroborationScore`
anywhere — each would imply a confidence this data cannot support.
Unresolved articles (zero persisted observations) are always counted, never
silently dropped.

**Confidence model.** `EXPLICIT` (a single observation's own directness),
`POSSIBLE` (two or more articles explicitly cite the same resolved
entity), `STRONGLY_INFERRED` (only the near-duplicate-text signal
currently reaches this), and `UNKNOWN`. `CONFIRMED` is deliberately not a
member of this set — confirming identical origin would require an
identifier (a dispatch id, a docket number) Phase 7B's extractor does not
capture, so this module may legitimately never produce anything above
`STRONGLY_INFERRED` today. That is an accepted, intentional limitation.

**Claim-level reasoning is explicitly out of scope.** Nothing here ever
produces language or data equivalent to "this article is corroborated by
Reuters and the court filing," "this fact was independently verified," or
"X and Y confirm the same claim." Phase 8B groups provenance **signals**
only; reasoning about individual factual claims is Phase 10's job.

**Defensive observation cap (touches Phase 7B code).**
`persistObservationsForArticle` now caps auto-generated observations at
`MAX_OBSERVATIONS_PER_ARTICLE` (20) per `(articleId, extractorVersion)`,
computed against what's already durably persisted (so it holds across
separate TITLE/FEED_TEXT calls for the same article), prioritizing `HIGH`
over `MEDIUM` while otherwise preserving textual order, idempotent on
rerun, and never counting, deleting, or destabilizing an `ADMIN_OVERRIDE`
row. See SECURITY.md for the threat this closes.

The budget check and the writes that consume it run inside one
`prisma.$transaction`, closing a real race an adversarial review of this
phase found: without it, two concurrent calls for the same
`(articleId, extractorVersion)` (e.g. live ingestion overlapping a
manually-triggered backfill touching the same article) could each read the
same pre-write count and collectively write well past the cap — verified
directly (two concurrent calls each 15-under-cap collectively wrote 30
rows before the fix; 0 after). The realistic worst case this codebase's
own call sites can produce is two concurrent calls per article, which is
now regression-tested and reliable. At meaningfully higher, synthetic
concurrency (5+ simultaneous calls for the same article — not reachable
through any current call site, since ingestion is sequential per article
and backfill's own concurrency is always across _different_ articles),
SQLite's single-writer contention can hit the transaction's timeout; every
racing call then rejects rather than the cap being violated, and every
caller of `persistObservationsForArticle` already wraps it in a try/catch
(`ingestSource.ts`, `backfill-provenance.ts`), so that failure mode is
fail-closed and isolated, never a crash and never a cap violation — an
accepted residual risk given current call patterns, not something this
phase's architecture (SQLite, no new schema) can fully eliminate.

**Database query shape.** `getClusterOriginSummary` runs exactly three
Prisma queries regardless of cluster size: a cluster-existence check, one
relational query for the cluster's articles with their source and
`ProvenanceObservation` rows (a join, not an explicit article-id `IN`
list), and one query for the full (small, by design) `ProvenanceEntity`
table — the same "load the small table once" precedent
`loadAliasIndex` already established. Never one query per article or per
observation.

**extractorVersion is never silently mixed.** The `ProvenanceObservation`
query only loads the current `EXTRACTOR_VERSION`'s auto-generated rows,
plus any `ADMIN_OVERRIDE` row regardless of its own version tag — mirroring
`clearStaleObservations`'s own exclusion rule. An article not yet
reprocessed after an extractor version bump is treated the same as an
article with no provenance at all here, rather than having its
possibly-since-corrected stale observations blended in with fresh ones
from other articles in the same cluster.

**`entityType` distinguishes two different kinds of "shared" citation.** A
`WIRE_SERVICE`/`NEWS_OUTLET` `SharedReportingSourceGroup` means the
articles cite a reporting intermediary (Reuters, AP, another outlet). A
`GOVERNMENT_AGENCY`/`COURT`/`LAW_ENFORCEMENT`/`COMPANY`/
`RESEARCH_INSTITUTION`/`INDIVIDUAL` group instead means the articles cite
the same primary source/newsmaker directly (e.g. two articles both quoting
the same DOJ statement) — routine, and if anything an even weaker signal
than a wire-service citation, since many outlets independently attending
the same press conference is completely unremarkable. Both are grouped the
same way (same resolved entity, `POSSIBLE` confidence) because both are
honestly the same underlying fact ("these articles cite this entity"), but
a consumer must inspect `entityType` rather than assuming every group
represents a reporting-intermediary relationship.

**Near-duplicate comparison ignores excerpts too short to be meaningful.**
Below `MIN_WORDS_FOR_COMPARISON` (8) words, an excerpt is excluded from
near-duplicate comparison entirely. Word-shingling degenerates for very
short text (a short excerpt collapses to a single whole-text "shingle"),
so two merely coincidentally-identical short fragments — a malformed feed
leaving only a placeholder like "Breaking News" — would otherwise score a
perfect 1.0 similarity from almost no real evidence; found and fixed
during adversarial review.

**Explicitly not in this phase**: no persisted graph or migration, no
public API, no UI, no claim-level reasoning, no single independent-origin
number, no document-identifier extraction, no cross-cluster reasoning, no
new network access, no change to clustering behavior itself. See Phase 9
(surfacing this to users) and Phase 10 (claim-level reasoning) for what
comes next.

**Known Phase 8B limitations**: a `mergedIntoId` chain longer than
`MAX_MERGE_CHAIN_DEPTH` (25 hops — far beyond any realistic admin merge
activity given Phase 7B's tiny seed entity set) can truncate before
reaching the true root, which would split what should be one group into
several rather than merging them — a false-negative, never a false
merge, consistent with this phase's precision policy. Shingle-based
similarity is English/space-delimited-language-oriented; a
space-delimited language degrades gracefully, while a script with no
inter-word spaces (e.g. CJK text) collapses toward exact-match-only
comparison — again a false-negative direction, never overclaiming.

## Story Intelligence — "Trace this story" (Phase 9B)

Phase 9B is the first time Phase 7/8's provenance intelligence is shown
directly to ordinary users, on the existing canonical `/story/[slug]`
page — no dedicated route, no new public API. It follows this repo's
established data-loading pattern exactly: the Server Component calls a
`src/lib` function directly, the same way `getStoryClusterBySlug` already
does.

**Server-side integration.** `StoryPage` calls
`resolveStoryIntelligenceViewerId()` (resolves the current session,
failing safely to anonymous on any error — see below) and
`getRelatedClusters` in parallel, then calls
`loadStoryIntelligence(cluster, viewerId)`
(`src/lib/storyIntelligence.ts`), which loads `getClusterOriginSummary`
and the viewer's `provenance_full` entitlement, and maps both through the
safe view-model layer. The result is passed straight to
`<StoryIntelligence>` (`src/components/story/StoryIntelligence.tsx`), a
Server Component. The only Client Component is
`<EvidenceDrawer>` (`src/components/story/EvidenceDrawer.tsx`), which
handles the expand/collapse interaction and receives nothing but the
already-safe view model.

**The safe view-model boundary.** `src/lib/storyIntelligenceView.ts`'s
`buildStoryIntelligenceView` is the ONE place `ClusterOriginSummary` (which
carries `observationId`/`entityId`/`extractorVersion`/`reviewState`/
`dedupeKey`/`startOffset`/`endOffset`/raw confidence enums — see Phase
8B's own section above) is converted into `StoryIntelligenceView`, the
only shape ever passed to a Client Component or otherwise serialized to
the browser. It's a pure function (no Prisma, no auth, no I/O), which
makes every guarantee below directly unit-testable without a database —
see `src/lib/storyIntelligenceView.test.ts`'s dedicated tests proving no
forbidden key ever appears in the output, regardless of entitlement.

**Entitlement gating happens in the data, not in CSS.** `hasFullAccess`
(from the existing `provenance_full` entitlement — already present on the
Basic/Pro plans, no new entitlement key was added) controls what the
mapper _includes_ in the object: a non-entitled viewer's reporting-source
groups simply never have `articles`/`evidence` populated, and the group
list itself is truncated to `MAX_FREE_REPORTING_GROUPS` (2) — there is no
premium data anywhere in the object for a client-side layer to hide.
`totalReportingSourceGroupCount` still reports the true total so the Free
preview can honestly say "+N more detected."

**Live counts, not denormalized ones.** `articleCount`/`publisherCount`
are read directly from `ClusterOriginSummary` (computed live, at query
time, from the actual article set `getClusterOriginSummary` analyzed) —
never from `StoryCluster.articleCount`/`sourceCount`, which are a
separately-denormalized field the clustering engine writes and could, in
principle, drift from what Phase 8 actually sees for this cluster. A
reporting-source group's own `articleCount` is Phase 8's own already-
deduplicated distinct-article count — an article with five separate
Reuters observations counts as one citing article, never five.

**Bounded display, even for a pathological cluster.** Phase 8 is tested
against 1,000-article clusters; without a defensive limit, a single
expanded reporting-source group could try to render 1,000 article rows
and up to 5,000 evidence snippets. `MAX_ARTICLES_PER_GROUP_DISPLAY` (50)
bounds `articles`/`evidence` per group (and per the original-reporting
list) independently of the group's own true `articleCount`, which is
never truncated. Within whatever's displayed, `MAX_EVIDENCE_PER_ARTICLE`
(5) further bounds evidence snippets per article, HIGH-prioritized over
MEDIUM internally — the raw confidence value itself is never exposed. A
third, TOTAL cap (`MAX_EVIDENCE_ITEMS_PER_GROUP`, 100) bounds the
flattened evidence list for one group even when every displayed article
contributes its own per-article maximum (50 articles x 5 snippets could
otherwise reach ~50,000 characters of publisher-sourced text for one
expanded group). Whenever a group or the original-reporting list is
actually truncated, `EvidenceDrawer` says so explicitly ("Showing 50 of
127 articles") rather than letting the true `articleCount`/`count` next to
a shorter list imply the display is complete or that articles are
missing/broken.

**Article links are scheme-sanitized before they ever reach a Client
Component.** `Article.url` is untrusted (ultimately from a publisher's RSS
feed), and `normalizeUrl()` (`src/lib/ingest/normalize.ts`) only
canonicalizes a URL — it does not restrict its scheme, so a malicious or
compromised feed could in principle supply a `javascript:`/`data:` link.
`storyIntelligenceView.ts` runs every article URL through `safeHttpUrl`
(`src/lib/security/sanitize.ts` — the same http(s)-only convention
`safeImageUrl` already establishes for feed-supplied image URLs) before
it's ever included in the view model; an unsafe scheme becomes `""`, and
`EvidenceDrawer` renders that case as plain, non-clickable text instead of
an `<a href>`.

**Failure isolation.** Story Intelligence must never take down the rest
of the story page, and an entitlement-service hiccup must never be treated
the same as "nothing to show." `loadStoryIntelligence` handles its two
failure sources differently on purpose: the entitlement lookup (`can()`)
has its own try/catch and fails CLOSED to `hasFullAccess = false` (the
Free/logged-out experience) rather than granting full access or hiding
already-available sourcing data; `getClusterOriginSummary` throwing means
there's nothing safe to show at all, so only that failure resolves the
whole section to `{ status: "unavailable" }`, rendered as "Story sourcing
details are temporarily unavailable," with no stack trace or internal
detail either way. Resolving the current viewer is handled _separately_,
by `resolveStoryIntelligenceViewerId`, which fails safely to anonymous
(the same fail-to-anonymous precedent `resolveViewerAdEligibility`
already establishes in `src/lib/ads.ts`) — before this feature, the story
page had no dependency on the auth/session tables at all, so a transient
failure there must degrade gracefully rather than take down a page that
previously never touched that table.

**Consumer terminology, and what's never shown.** "Provenance,"
`relationshipType`/`evidenceType` enum values, `POSSIBLE`/
`STRONGLY_INFERRED`, and raw `HIGH`/`MEDIUM` confidence are never
rendered — see `storyIntelligenceView.ts`'s translation into "Reporting
sources," "cited by"/"referenced by" (see below), "Original reporting,"
and "Sourcing not detected." Nothing here implies independent
confirmation, verification, or that shared attribution means the same
dispatch — see the "How Veriqen traces this" disclosure on the page
itself for the full, plain-language explanation and limitations.

**Wire service vs. directly-cited source.** A `WIRE_SERVICE`/`NEWS_OUTLET`
group is worded "cited by N articles" (a reporting-intermediary
relationship). Any other entity type (`GOVERNMENT_AGENCY`, `COURT`, etc.)
is worded "referenced by N articles" instead — a directly-cited primary
source, not a reporting act, and if anything an even more routine signal
(many outlets independently attending the same press conference is
unremarkable). Both are grouped identically underneath (same resolved
entity, `POSSIBLE` confidence); only the display verb differs, per Phase
8B's own entityType distinction.

**Deferred, explicitly out of scope for Phase 9B**: Story Map
visualization, primary-evidence UI (`primaryEvidenceGroups` stays
populated by the backend but unused by this UI — Phase 7's extractor
can't yet distinguish specific documents), claim extraction/comparison/
corroboration, AI summaries or synthesis, shareable intelligence cards,
Story Evolution, a URL analyzer, embeds, referrals, and any new
entitlement key, schema change, migration, or public API.

## Coverage Comparison — "Common assertions across coverage" (Phase 10B)

Phase 10B adds Veriqen's first **deterministic** claim layer: it extracts
a narrow, closed set of structured assertions from already-ingested
article text, persists them per-article, and — at query time, per story
cluster — groups conservatively similar assertions across articles and
cross-references that grouping against Phase 8's reporting-source
overlap. No AI, no embeddings, no external NLP, and no new network
fetching anywhere in this feature; everything operates on text already in
the database.

**Locked epistemic rule: repetition is not corroboration.** An assertion
appearing in 15 articles is a fact about repetition, not independent
confirmation — and if 9 of those 15 also cite Reuters, that is a
_second_, separately-displayed fact, never subtracted from the 15 and
never combined into an "independence score." Veriqen never concludes
truth or falsity, never says "N sources independently confirmed X," never
treats majority reporting as proof, and never calls an outlet biased or
lying. This rule is enforced structurally (`buildClaimGroups.ts`'s
`sourceOverlap` is a parallel array field, never arithmetic against
`articleCount`) as well as by a semantic-regression test suite
(`test/coverageComparisonSafety.test.ts`) that greps the actual shipped
source for forbidden affirmative phrasings ("N sources independently
confirmed," "verified the claim," "same dispatch," "plagiarized," etc.).

**Locked MVP claim taxonomy — exactly two kinds, nothing else.**
`NUMERICAL_ASSERTION` (a number tied to one of a closed set of units:
people, deaths, injuries, arrests, percent, USD, magnitude, years, votes,
acres, miles, kilometers) and `ATTRIBUTED_STATEMENT` (a sentence
containing an already-resolved Phase 7 attribution). Explicitly out of
scope: direct quotes, generic declarative claims, opinion/prediction/
allegation extraction, contradiction detection, semantic NLP, and any
sentiment/bias/truth/framing score. Precision is prioritized over recall
throughout — an ambiguous or unclear candidate is dropped, never guessed.

**Single Attribution Authority.** `ATTRIBUTED_STATEMENT` claims are never
independently re-detected. `buildAttributedStatementClaims.ts` takes
already-persisted Phase 7 `ProvenanceObservation` rows (for the exact same
article and extraction-source text buffer) as its only attribution input,
and derives each claim purely from "which sentence contains this
observation's span." This guarantees Phase 7 and Phase 10B can never
drift into disagreeing about who said what, by construction rather than
by discipline — there is deliberately no second attribution detector
anywhere in this feature.

**Data model — additive, one new table.** `Claim`
(`prisma/migrations/20260928222747_phase10b_claims/`) stores one row per
extracted assertion: `kind`, `rawText`/`normalizedText` (both bounded to
`MAX_CLAIM_TEXT_LENGTH`, 200 chars), an optional `entityId` (FK to
`ProvenanceEntity`, `SetNull` on delete — reused from Phase 7, never a
new entity system), optional `numericValue`/`numericUnit`/
`numericQualifier` for `NUMERICAL_ASSERTION` rows, `extractionSource`
(reusing Phase 7's exact `TITLE`/`FEED_TEXT`/`STORED_EXCERPT_BACKFILL`
semantics — historical backfill can never honestly claim `FEED_TEXT`),
`startOffset`/`endOffset`, `confidence` (`HIGH`/`MEDIUM` only — see
below), `claimExtractorVersion`, `reviewState` (defaults to
`UNREVIEWED`; an `ADMIN_OVERRIDE` row is never touched by reprocessing or
backfill), and a unique `dedupeKey` (SHA-256 of the fields that make an
extraction "the same one" — identical convention to
`ProvenanceObservation.dedupeKey`). There is deliberately **no**
`ClaimGroup`, `ClaimOccurrence`, contradiction, truth, or score table:
cross-article grouping is never persisted, mirroring `StoryCluster` +
`SharedReportingSourceGroup`'s Phase 8 precedent exactly (persisted
per-article facts, recomputed cross-article reasoning).

**Confidence stays internal and split by concern.** The extractor's own
output type allows `LOW`, but `persistClaimsForArticle` never persists a
`LOW` row (false negative preferred over false positive, exactly Phase
7B's own policy). Raw confidence is never exposed to a consumer, and
there is no single combined "claim confidence score" anywhere — extraction
confidence, grouping similarity (`SIMILARITY_THRESHOLD`), and attribution
confidence (inherited from the underlying `ProvenanceObservation`) are
kept as three separate internal concepts, never averaged into one number.

**Extraction pipeline** (`src/lib/claims/`):
`sentenceBoundary.ts` is a dependency-free, bounded
(`MAX_SENTENCES_PER_TEXT`), abbreviation-aware sentence splitter — the
foundational primitive both claim kinds build on, not a linguistic
parser. `numberPatterns.ts` matches a closed set of unit regexes
(`UNIT_RULES`) plus a qualifier detector (`EXACT`/`AT_LEAST`/`MORE_THAN`/
`AT_MOST`/`LESS_THAN`/`APPROXIMATE`) and a bounded multiplier table
(thousand/million/billion/trillion, capped at `MAX_NUMERIC_VALUE`), then
suppresses overlapping candidates (same algorithm shape as Phase 7's
`suppressOverlaps`). `extractNumericalAssertions.ts` sentence-splits,
finds number candidates, and **discards any candidate whose containing
sentence contains a negation word** (reusing Phase 7's own
`NEGATION_WORDS` set, now exported from `patterns.ts` for this reuse) —
"no injuries were reported" and "did not arrest 3 people" can never
produce a claim, by construction; this is a coarse, whole-sentence check
(false negative over false equivalence), not a parse of what the negation
actually scopes over. `buildAttributedStatementClaims.ts` implements the
Single Attribution Authority rule above. `normalize.ts` aliases the
existing `normalizeTitle` (lowercase, Unicode-safe whitespace, punctuation
normalization) as `normalizeClaimText` — deliberately no synonym
dictionary, embeddings, or stemming: "injured" and "hospitalized" are
never treated as equivalent, only exact structural/qualifier agreement
groups two numerical claims together.

**Persistence, capped and concurrency-safe** (`persistClaims.ts`).
`MAX_CLAIMS_PER_ARTICLE` (20) is enforced across the whole article, not
just one extraction call, with HIGH-confidence candidates prioritized
ahead of MEDIUM before the cap is applied. The budget check and the
writes that consume it run inside one `prisma.$transaction`, so two
concurrent calls for the same `(articleId, claimExtractorVersion)` —
title extraction and feed-text extraction both running at ingestion,
or two overlapping backfill workers — can never both read a stale
pre-write count and collectively overshoot the cap. This is the exact
concurrency shape `persistObservations.ts` already established, adopted
here specifically to avoid repeating Phase 8's own previously-fixed
observation-cap race (see `test/claimPersistence.integration.test.ts`'s
dedicated concurrency test).

**New-article extraction** happens at the same transient,
already-sanitized feed-text ingestion boundary Phase 7 already uses (see
`ingestSource.ts`'s `extractAndPersistClaims`) — zero new network fetch.
It runs immediately after Phase 7's own provenance extraction and reads
back the observations that call just persisted, then calls
`persistClaimsForArticle` once for `TITLE` and once for `FEED_TEXT` (if
present). It has its own isolated `try`/`catch`, separate from both
article creation and provenance extraction: a claim-extraction bug must
never prevent an article from being created or be mistaken for a
provenance failure.

**Historical backfill** (`worker/backfill-claims.ts`) is modeled directly
on `backfill-provenance.ts`: explicitly invoked (`npm run
backfill:claims`), cursor-based (`orderBy: { id: "asc" }` + `cursor`/
`skip`, resumable via `--after=<id>`), bounded batch size and
concurrency, `--dry-run` support, and zero network. A historical article
only ever has `title` and `excerpt` stored — the fuller feed text seen at
ingestion time was never persisted — so this script can only ever
produce `TITLE` or `STORED_EXCERPT_BACKFILL` extraction sources, never
`FEED_TEXT`; a structural test asserts the literal string `FEED_TEXT`
never appears as a claimed extraction source in this file. It clears
stale-version claims (preserving any `ADMIN_OVERRIDE` row regardless of
version) before reprocessing each article.

**Query-time grouping, never persisted** (`buildClaimGroups.ts`), scoped
to one `StoryCluster`'s already-loaded, current-version claims — pure,
deterministic, no I/O. The two claim kinds have different safety profiles
and are handled differently on purpose:

- `NUMERICAL_ASSERTION` claims need no text-similarity comparison at all:
  exact agreement on `(numericUnit, numericValue, numericQualifier)` IS
  the grouping key. This is both _safer_ than fuzzy comparison (a
  qualifier or unit mismatch can never be silently smoothed over — "12
  injured" and "at least 12 injured" never group) and strictly linear —
  one `Map` bucketing pass, no pairwise comparison, no bucket-size cap
  needed at all.
- `ATTRIBUTED_STATEMENT` claims first bucket by resolved canonical entity
  (reusing Phase 8's own `resolveCanonicalEntityId`, so a merged
  "DOJ"/"Department of Justice" entity resolves identically in both
  features), since same-speaker alone is not sufficient to group two
  statements. Within an entity bucket, bounded single-linkage TF-IDF/
  cosine clustering (reusing `clustering/tfidf.ts`, same
  `SIMILARITY_THRESHOLD` shape as `excerptSimilarity.ts`'s own precedent)
  further splits genuinely similar statements from merely-same-speaker
  ones. A bucket larger than `MAX_GROUP_SIZE_FOR_TEXT_COMPARISON` (25) is
  **skipped entirely** for that entity — never compared exhaustively — and
  the absence of a group there must never be read as "these statements
  disagree," only that the bucket was too large to safely compare.

Either way, a group requires `MIN_ARTICLES_FOR_GROUP` (2) distinct
articles to exist at all — a single article's own claim is never
displayed as a "shared assertion." `computeSourceOverlap` cross-references
a group's article-id set against Phase 8's already-computed
`sharedReportingSourceGroups` for the same cluster, returning a _separate_
array (`sourceOverlap`) — this is the direct implementation of
"repetition is not corroboration": a group's `articleCount` (true
repetition) and its `sourceOverlap` (which of those articles also cite,
say, Reuters) are always two different fields, never arithmetic against
each other. Verified end-to-end at 1,000 claims in a single bucket in
under the test's time budget with no pairwise comparison at all
(`buildClaimGroups.test.ts`'s "Y" scenario).

**Headline comparison** (`headlineComparison.ts`) is a separate, purely
descriptive comparison over one text surface that's never truncated
regardless of an article's age: named entities (reusing
`extractKeywordPhrases`), numbers (reusing `numberPatterns.ts`), and
publisher-labeled perspective (reusing `classifyPerspective` from
`perspective.ts`, unchanged). It lists what each headline mentions and
which entities are shared across 2+ headlines — it never scores framing,
infers motive, or claims that a headline's silence on something means the
full article omitted it.

**Safe view model** (`coverageComparisonView.ts`) is the one boundary
between internal shapes (`ClaimGroup`, whose `members` carry a Claim's
internal id/entityId/offsets/raw confidence) and anything ever rendered
or serialized to a browser — a pure mapper, no Prisma, no auth, no I/O,
following Phase 9's `storyIntelligenceView.ts` pattern exactly.
`hasFullAccess` (`coverage_comparison_full`) and `hasClaimComparison`
(`claim_comparison` — both existing entitlement keys, no schema/seed
change) control what fields are _included_ in the object, never what's
hidden by CSS: `sourceOverlap` is present only for Basic+, and
`occurrences` (per-article evidence, capped at
`MAX_OCCURRENCES_PER_GROUP_DISPLAY`, 50) only for Pro. Free/logged-out
gets a small bounded preview (`MAX_FREE_CLAIM_GROUPS`, 2 groups; up to
`MAX_HEADLINE_ENTRIES_FREE`, 3, headline entries) with the true totals
still reported so the upsell can say "+N more detected," never a
completely empty section. Claim group text/evidence is capped throughout
(`MAX_CLAIM_TEXT_LENGTH`, `MAX_CLAIM_GROUPS_DISPLAYED`) — short
structured assertions, never large quantities of copied publisher text.
Every article URL is run through the same `safeHttpUrl` gate Phase 9B
established; an unsafe scheme renders as plain non-clickable text. A
group's client-visible `key` (used only for React reconciliation) is
built exclusively from already-consumer-safe fields — it must never
incorporate a raw `entityId`, which has no legitimate consumer-facing use
anywhere in the app (see the adversarial-review finding in this phase's
PR description).

**Orchestrator** (`coverageComparison.ts`) mirrors `storyIntelligence.ts`
exactly: each entitlement check has its own independent try/catch and
fails CLOSED (an entitlement-service hiccup degrades to Free behavior,
never grants access and never hides already-available data);
`getClusterOriginSummary` plus the claim/entity queries have a separate
try/catch, and only that failure resolves the whole section to
`{ status: "unavailable" }` — the rest of the story page (Trace this
story, sharing, bookmarking, ads, the pre-existing per-outlet "Compare
coverage" timing section) is entirely unaffected either way.

**UI placement and terminology.** Rendered on the existing
`/story/[slug]` page, immediately after "Trace this story" — no new
route, no new public API, no modal-only experience. The section's own
heading is deliberately **"Common assertions across coverage"**, not
"Compare coverage": the page already has a pre-existing "Compare
coverage" section (`id="compare"`, unrelated per-outlet headline/timing
comparison predating this phase), and an identical duplicate `<h2>` would
confuse heading-hierarchy navigation. Locked terminology throughout:
"Appears in N articles," "N of these articles cite Reuters" (always as a
separate sentence from the article count), "Attributed to [organization],"
"Not detected in the available text" (never "omitted"/"did not
report"/"hid"). A "How Veriqen compares coverage" `<details>` disclosure
states the limitations in plain language, including that "not all
comparable assertions are written explicitly, so some go undetected."

**Deferred, explicitly out of scope for Phase 10B**: any AI/LLM/
embeddings-based extraction, contradiction detection, truth or bias
scoring, a public claims/coverage API, a dedicated `/compare` or `/claims`
route, Story Map, Primary Evidence UI (the document-identity gap Phase
10A identified is unchanged), and any new entitlement key. Phase 11, if
it happens, would consume this phase's structured `Claim`/`ClaimGroup`
output — it has not been started.

## AI Story Brief — Pro AI intelligence layer (Phase 11B)

Phase 11B adds Veriqen's first feature that calls a language model at
request time. Its locked core principle: **AI may explain Veriqen's
structured data. AI must not become a source of truth.** Every other
design decision in this section follows from that one rule.

**AI-above-deterministic-systems.** The model sits strictly on top of the
deterministic pipelines Phases 7-10 already built (provenance extraction,
source-group reasoning, claim grouping, coverage comparison) — it never
replaces, second-guesses, or independently re-derives any of their output.
It cannot determine what actually happened, which account is correct,
whether anything is true/false/biased/reliable, or whether one article's
sourcing is more "independent" than another's — those are exactly the
judgments Phases 7-10 themselves refuse to make (see the Coverage
Comparison section above), and the AI layer inherits the same refusal
rather than smuggling a soft version of it back in through model
narration.

**Structured input boundary — no full article text, ever.**
`src/lib/ai/storyBrief/input.ts`'s `buildAiStoryBriefInput()` is the
_only_ way data reaches the model, and it is built exclusively from two
already-safe, already-bounded view models: `StoryIntelligenceView`
(Phase 9B) and `CoverageComparisonView` (Phase 10B, which itself embeds
the headline comparison). It never touches a raw Prisma `Article`,
`Claim`, or `ProvenanceObservation` row, and never independently
re-queries the database. This means the model can never see more than a
Pro viewer's browser already renders on the story page — no raw article
excerpt or feed text, no internal database ids, no user email/id/
subscription id, no saved-stories or browsing-history data, and no
`ExternalAssessment`/source-profile ratings. Total input is capped at
roughly 4,000 characters (≤10 claim groups, ≤5 source groups, ≤10
headlines, each item ≤200 chars).

**Ephemeral, per-request reference ids.** Every fact handed to the model
carries a fresh id built only for that one request — `CLAIM-GROUP-N`,
`SOURCE-GROUP-N`, `HEADLINE-N` — never a database id, never stable across
requests. `collectValidReferences()` builds the exact closed set of valid
ids from the same input, and the server independently validates every
`refs[]` entry a model output cites against that set — a model-supplied
ref is never trusted merely because it has the right shape.

**Prompt-injection model.** All publisher-controlled text (headlines,
claim text, occurrence text, entity/source names) is treated as hostile.
`src/lib/ai/storyBrief/prompt.ts` keeps system instructions and the data
payload structurally separate (a chat API's `system`/`user` roles —
`ollamaProvider.ts` — never one concatenated string), and the
instructions explicitly tell the model that the data block is data, never
an instruction, even if it reads like one. This separation is
**defense-in-depth, not the security boundary**: a model still reads both
as one token stream and can be influenced regardless of which "role" the
hostile text arrived in. The real boundary is output validation, which
runs unconditionally on every response regardless of what the model was
told or shown.

**Grounded output contract and validation pipeline.**
`src/lib/ai/storyBrief/schema.ts` defines the only shape a response may
take: `summary` plus `commonAssertions`/`coverageDifferences`/
`sourceOverlapNotes` (arrays of `{text, refs}`, `refs` required and
non-empty), `unresolvedQuestions` (`{text}`, no refs — describing an
absence needs no citation), and a `limitations` field that is **always
server-templated**, never accepted from the model. `validateAiStoryBriefOutput()`
runs, in order: raw-length cap → JSON parse → plain-object/unknown-field
rejection (top-level and per-statement) → length/array caps → URL-scheme
rejection (explicit allowlist, not generic pattern matching) → a runtime
forbidden-language check (`languagePolicy.ts` — an independent second
layer beyond the system prompt, covering "confirmed," "verified,"
"biased," "omitted," "same dispatch," etc., in any form) → refs-required
and refs-must-exist-in-server-set checks. At most one regeneration is
attempted after invalid output, then the request fails closed to
`unavailable` — malformed output is never partially rendered.

**Provider abstraction and network boundary.** `src/lib/ai/provider.ts`
defines a narrow `AIProvider.generateStructured()` interface; the only
implementation is `storyBrief/ollamaProvider.ts`, built on the existing
Ollama architecture (no new vendor SDK). It uses a bounded response
reader (fixing the gap Phase 11A identified in the older, unrelated
`src/lib/ai/ollama.ts`'s unbounded `res.json()`), disables redirects, and
enforces a timeout. The outbound boundary is an operator-configured fixed
endpoint (`AdminSetting`/env, same precedent as the old AI config) —
distinct from, and never altering, the publisher-facing SSRF guard
(`assertPublicHttpUrl`), which governs a completely different trust
boundary (fetching feeds Veriqen doesn't control) than this one (calling
an endpoint the operator themselves configured). Tests use a deterministic
mock provider (`src/lib/ai/testing/mockProvider.ts`); no test depends on
a live provider.

**Caching and quota semantics.** `AiStoryBrief`
(`prisma/migrations/20260929010000_phase11b_ai_story_brief/`) is one
additive table that doubles as both the persisted artifact and the
cache, keyed by `[storyClusterId, feature, inputFingerprint,
promptVersion, provider, model]`. The fingerprint
(`storyBrief/fingerprint.ts`) is a SHA-256 of the exact bounded input
object, so cache invalidation happens "for free" whenever anything the
model actually saw changes (new article, changed claims/provenance, an
extractor-version bump, or a prompt/model-version bump) — there is no
separate invalidation logic to keep in sync. A cache hit returns the
validated cached JSON directly and **never** calls the provider or
touches quota. Quota (the existing `ai_monthly_quota` entitlement, gated
by the existing `cross_source_synthesis` boolean — Phase 11A's key
finding was that both were already seeded and needed no schema change) is
consumed **only** after a provider call succeeded and its output passed
every validation step; provider failures, validation failures, empty
responses, entitlement failures, and cache hits never cost a unit.
`reserveUsage()`/`releaseUsage()` (`src/lib/entitlements.ts`) implement
this as a reserve-before-call, release-on-failure pattern, concurrency-safe
via the identical single-transaction read+write shape Phase 10B's
`persistClaimsForArticle` already established for its own per-article
caps (see `test/aiStoryBriefQuotaRace.integration.test.ts` for the
adversarial concurrent-reservation proof). A per-user rate limit and
in-memory single-flight deduplication (`storyBrief/singleFlight.ts`)
further reduce redundant provider calls for near-simultaneous identical
requests.

**Failure isolation.** `src/lib/aiStoryBrief.ts` wraps the whole feature
in its own top-level try/catch, and the orchestrator itself
(`storyBrief/generate.ts`) independently fails closed to `unavailable` on
any internal exception — including one from the quota-reservation step
itself — rather than relying solely on the caller's own error handling. A
provider outage, validation failure, or any other internal error makes
the AI Story Brief section unavailable; it never breaks Story
Intelligence, Coverage Comparison, the Timeline, sharing, bookmarking,
ads, or the rest of the story page.

**Old summary pipeline — separate and untouched.** The pre-existing
`StoryCluster.summary` / `refreshSummaries()` extractive-summary pipeline
(see `src/lib/ai/index.ts`) is a completely different feature with its
own independent kill switch and its own `/api/generate`-based Ollama
call. Phase 11B never reads or writes `StoryCluster.summary`, never
reuses its provider call path, and can be enabled/disabled independently
via its own `storyBriefEnabled` config flag.

**UI placement.** The AI Story Brief renders on `/story/[slug]`
immediately after "Common assertions across coverage" and before
"Compare coverage," collapsed by default behind a native `<details>`
(zero client JS), with a persistent "AI-generated" label and a "How was
this generated?" disclosure. Free/Basic viewers see a teaser only — the
full brief is never generated server-side merely to hide it client-side.

## Stripe billing — Basic/Pro subscriptions (Phase 12B)

Phase 12B connects real commercial billing to the Plan/Entitlement
architecture Phase 2 already established, without turning Stripe into a
second, independent source of truth for what a user can do. The locked
architectural principle: **Stripe decides commercial subscription state;
Veriqen's existing entitlement system decides product capabilities.**

**Free-subscription invariant preserved exactly.** Every user — including
Free — has always had exactly one `Subscription` row (`src/lib/auth/
consumer/service.ts`'s `registerUser`). Phase 12B never changes that:
every plan change (checkout completing, a Portal-driven switch,
cancellation) **updates that same row in place** (`src/lib/billing/
webhookSync.ts`) — it never inserts a second row for a user. This is why
`Subscription.externalSubscriptionId` became `@unique`: a given Stripe
subscription id can map to exactly one local row, by construction.

**`BillingProvider` abstraction** (`src/lib/billing/provider.ts`) —
directly analogous to Phase 11B's `AIProvider` boundary. Product code
(checkout/portal/webhook routes, and `entitlements.ts`'s status check)
never touches the Stripe SDK directly; `src/lib/billing/stripeProvider.ts`
is the **only** file that imports `stripe`, and every test in the repo
runs against `src/lib/billing/testing/mockProvider.ts` instead — no
automated test requires a live Stripe account, a real card, the Stripe
CLI, or internet access.

**Trusted Price mapping, fail-closed on the unknown.**
`src/lib/billing/planMapping.ts` is the only place a Stripe Price id maps
to a Veriqen plan slug, built from `src/lib/billing/config.ts`'s
env-sourced `STRIPE_BASIC_PRICE_ID`/`STRIPE_PRO_PRICE_ID`. A client may
request only `"basic"` or `"pro"` (a closed enum,
`isPaidPlanSlug()`) — never a price id, customer id, or subscription id.
A webhook whose subscription references a Price id outside this map is
never guessed into a plan; the sync is skipped entirely for that event
(logged, and still marked processed so Stripe stops retrying an event no
retry could ever resolve — see `webhookSync.ts`'s own `unknown_price`
outcome).

**Test/live isolation (Amendment A).** `config.ts` never infers Stripe's
mode from a Price id's or webhook secret's own formatting — Stripe
documents no such convention for either. Instead, `STRIPE_MODE`
(`"test"` | `"live"`) is an explicit, required setting, cross-checked
only against the ONE property Stripe's own API documentation guarantees:
a secret/restricted key's `sk_test_`/`rk_test_` vs. `sk_live_`/`rk_live_`
prefix. Any mismatch, or any required variable being unset, disables
billing entirely (`{enabled: false}`) rather than falling back to a
default mode or guessing — proven by `src/lib/billing/config.test.ts`'s
own "cannot silently fall back" tests.

**Checkout — first purchase only.** `POST /api/billing/checkout`
(session-authenticated, CSRF-protected like every other consumer-account
route) validates the plan slug, resolves the trusted Price id server-side,
reuses (or creates and persists) the user's Stripe customer id, and
creates a Checkout Session with server-controlled, fixed-path
success/cancel URLs (`src/lib/siteUrl.ts`'s `getSiteUrl()` plus a literal
path — no client input reaches the redirect target at all, which is what
makes an open redirect structurally impossible here rather than merely
validated against). **An already-paid user is never routed through
Checkout again** — `createCheckoutForUser` rejects with
`already_subscribed` if the caller's current subscription already grants
paid access, directing them to the Customer Portal instead (see below).
The success redirect itself grants nothing: the account page's "processing
your upgrade" message is purely informational, never a trust signal — the
only thing that ever changes `Subscription` state is a verified webhook.

**Customer Portal handles everything else.** Card updates, cancellation,
reactivation, invoices, billing history, and **paid-plan switching**
(Basic↔Pro) are all delegated to Stripe's hosted Customer Portal
(`POST /api/billing/portal`) — Veriqen builds none of these itself. The
customer id passed to Stripe comes only from the authenticated caller's
own `User.externalCustomerId` row; there is no parameter anywhere in this
path a request could use to name a different customer.

**Webhook — the highest-risk trust boundary.** `POST /api/billing/webhook`
reads the raw request body with a bounded reader (mirroring Phase 11B's
`readBodyWithLimit` precedent — a body over ~64KB is rejected before any
signature check) and verifies Stripe's signature
(`BillingProvider.verifyWebhookEvent`) before trusting a single field of
the payload. The minimum sufficient event set, after reassessing per
Phase 12A's Amendment B, is exactly three: `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted` — see
`src/lib/billing/webhookSync.ts`'s own doc comment for why
`customer.subscription.created` (redundant with the checkout-completion
handler's own re-fetch) and `invoice.payment_failed` (Stripe already
reflects a failed renewal via the subscription's own `status` transition
to `past_due`/`unpaid`, which `customer.subscription.updated` already
carries — a dedicated invoice handler would only duplicate that signal,
and per Amendment B must never independently invent or override
subscription status) are both deliberately omitted.

**Never trust the embedded event payload as current state.** For every
handled event, the handler re-fetches the CURRENT subscription object
from Stripe (`BillingProvider.getSubscription`) rather than trusting the
webhook's own possibly-stale/out-of-order snapshot — a duplicate or
out-of-order delivery simply re-derives and re-applies whatever Stripe
says is true right now, which is always a safe no-op or a correct
overwrite, never a regression to older state.

**Webhook idempotency is atomic (Amendment C).** `ProcessedWebhookEvent`
(keyed by Stripe's own event id) is written **only inside the same
`prisma.$transaction`** as the `Subscription` row it corresponds to. If
synchronization fails for any reason, neither write commits — the event
is never marked processed, so Stripe's own retry re-invokes the handler
for the same event from scratch (safe: `getSubscription` is a pure read).
A concurrent duplicate delivery resolves the same way: whichever
transaction commits first wins, and the loser's failed unique-constraint
insert on `ProcessedWebhookEvent.id` is caught and treated as an ordinary
duplicate, never a partial application.

**Status → effective-plan matrix (`src/lib/entitlements.ts`'s
`grantsPaidAccess`)** — the ONE place in the codebase that decides which
Stripe-synchronized statuses currently grant paid entitlements. Everything
else, from the webhook sync to the UI, only ever reads or writes
`Subscription.status` as Stripe's own raw string — never re-encoding it.
Deliberately an ALLOW-list, never a deny-list, so an unrecognized future
Stripe status fails closed:

| Status                                                                  | Grants paid access?                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `active`                                                                | Yes                                                                                      |
| `past_due`                                                              | Yes (Stripe's own dunning/retry window — see the account page's payment-problem banner)  |
| `trialing`                                                              | Only if a future phase deliberately enables trials (`TRIALS_ENABLED`, currently `false`) |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`      | No                                                                                       |
| Anything else (including a genuinely unrecognized future Stripe status) | No — fails closed                                                                        |
| No Subscription row found at all                                        | No — falls back to Free (shouldn't happen; the invariant guarantees a row)               |

A `cancel_at_period_end` subscription whose `status` is still `active`
continues to grant access — Stripe itself only transitions `status` away
from `active` once the paid period genuinely ends, so this matrix needs
no special case for it.

**`getPlan()` never calls Stripe.** It only ever reads the local
`Subscription` row a verified webhook already synchronized — this is the
entire basis for Phase 12B's failure-isolation guarantee: a total Stripe
outage has zero effect on the public feed, story pages, search,
provenance, coverage comparison, Story Intelligence, or an
already-entitled Pro user's AI Story Brief access, since none of those
depend on Stripe being reachable at all.

**Minimum additive schema** (`prisma/migrations/20260929020000_
phase12b_stripe_billing/`): `Subscription.currentPeriodStart`,
`externalPriceId`, `lastSyncedAt` (all nullable), `externalSubscriptionId`
becoming `@unique`, and one new table, `ProcessedWebhookEvent`. No
changes to `User`, `Plan`, `Entitlement`, or `UsageRecord` — verified via
a populated migration smoke test (pre-Phase-12B data across every model,
including a pre-existing Pro `Subscription` row with the new columns
absent, survives the migration byte-for-byte, and the new columns/table
work correctly afterward).

**Privacy.** The only data Stripe ever receives is the user's email (for
receipts) and an opaque Veriqen user id as `metadata.veriqenUserId` — never
saved stories, browsing history, followed topics, source preferences,
article history, AI prompts/outputs, or provenance data. Server logs
carry only reason codes, event ids, and Stripe object ids — never the
secret key, the webhook signing secret, or a full webhook payload (see
SECURITY.md's own dedicated section for the adversarial proof).

**Secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are
environment-variables-only, exactly like `SESSION_SECRET`/
`ADMIN_PASSWORD_HASH` — never `AdminSetting`, never `NEXT_PUBLIC_*`. No
Stripe.js/Elements integration exists in the browser at all (Checkout and
the Customer Portal are both fully Stripe-hosted redirects), so no
publishable key is needed anywhere in this phase.

## Admin operations (Phase 13B)

Phase 13A audited the existing admin system end-to-end (see that audit's
own report, referenced from this repo's session history) and found: one
shared admin password (no per-admin identity), no operational visibility
into billing at all, no operational visibility into ingestion health, and
an AI Story Brief kill switch that only existed as an environment
variable. Phase 13B closes exactly those gaps — deliberately not a CMS
redesign, not an analytics platform, not user management.

**Admin identity remains the single shared password.** Phase 13B does not
introduce `AdminUser` rows, multiple admin identities, or any path from a
consumer account to admin access — see SECURITY.md's own updated threat
model for why this remains the accepted approach for now.

**Billing visibility** (`src/lib/billing/adminStatus.ts`,
`getBillingAdminStatus()`) reuses Phase 12B's own `getRuntimeBilling()`/
`getBillingConfig()` exactly as every billing route already does — no
billing logic is duplicated, and no live Stripe call is ever made to
render this. It reports: whether billing is configured, the declared mode
(`test`/`live`), the same static (secret-free) diagnostic reason string
already used internally when disabled, local subscription counts grouped
by status, and a count of Stripe-backed subscriptions whose
`lastSyncedAt` is still null (per that column's own doc comment in
`schema.prisma`, the one unambiguous "never confirmed by Stripe" signal
derivable from existing columns without inventing a new staleness
threshold). This surface is read-only: there is no route or function
anywhere in `adminStatus.ts` that writes a `Subscription` row, and an
administrator cannot fabricate paid access, change plan/status, or touch
`externalSubscriptionId` from anywhere in the admin panel — Stripe and the
Customer Portal remain the only place billing state actually changes.
`duplicate_subscription_conflict` (Phase 12B's webhook defense-in-depth)
remains server-log-only in this release — see Known limitations.

**Ingestion liveness** (`src/lib/ingest/adminLiveness.ts`,
`getIngestionLivenessStatus()`) is derived ENTIRELY from existing columns
(`Source.lastFetchedAt`/`fetchIntervalMinutes`, `FeedFetchLog`) — no new
worker-heartbeat mechanism was added, because the worker
(`worker/index.ts`) is a separate process with no shared state to expose
one through, and the existing columns already prove everything this needs
to prove. A source is "overdue" once unfetched for more than 2× its own
interval (a grace period sized against the worker's default 5-minute tick
cadence) or never fetched at all; only active sources are ever considered.
The admin dashboard's copy deliberately says "sources overdue for
scheduled fetch," never "worker offline" — this can prove the former, not
the latter.

**AI Story Brief kill switch.** `aiSettingsSchema`
(`src/lib/validation/settings.ts`) gained one additive, optional field,
`storyBriefEnabled`, alongside the pre-existing `provider`/`baseUrl`/
`model`. A pre-Phase-13B `"ai"` `AdminSetting` row simply lacks the key,
and `getAiConfig()`'s existing merge order
(`{...DEFAULT_CONFIG, ...envDefaults(), ...parsed}`) falls through to the
environment-derived default exactly as before — this is purely additive,
never a breaking change to that row's shape. Toggling it takes effect on
the very next request with no restart, because `getAiConfig()` already
reads fresh from the database on every call. The kill switch is a genuine
kill switch, not merely a generation pause: `generateAiStoryBrief`
(`src/lib/ai/storyBrief/generate.ts`) checks `storyBriefEnabled` BEFORE
its own cache lookup, so a previously-cached artifact is also hidden
while disabled, not just blocked from being regenerated — re-enabling
makes the same cached artifact visible again with no new provider call.
`storyBriefTimeoutMs` remains environment-only in this release (Phase 13A's
own scope decision) and is never sent to the client — the admin
settings page explicitly picks only the four exposed fields rather than
spreading the full server-side `AiConfig` object into its client props.
The toggle changes nothing about `cross_source_synthesis` entitlement or
`ai_monthly_quota` usage state, and nothing about the `AIProvider`
abstraction itself.

**Source-delete warning.** The existing hard-delete-with-cascade behavior
(deleting a `Source` cascades to its `Article`s, which cascade further to
`ArticleKeyword`/`ProvenanceObservation`/`Claim`) is UNCHANGED — Phase 13B
only fixed the admin confirm-dialog's wording, which previously read
"Remove this source and its association with existing articles?" (readable
as "articles survive") when in fact they do not. No archive/soft-delete
semantics were introduced.

**Minimal admin audit log** (`AdminAuditLog`, `src/lib/adminAudit.ts`).
One additive table, written ONLY by `logAdminAction()` from within a
route's own successful-mutation path — never for a read-only page view,
and never for a request that never reached the mutation (auth failure,
CSRF failure, validation rejection). There is deliberately no
admin-identity column: the shared-password model (above) means there is
currently nothing meaningful to put in one — this table answers "an
authenticated administrator performed this mutation at this time," not
"which one." Every `summary` is a short, hand-written, pre-redacted string
fixed at each call site — never a serialized request body, never an error
object — which is what makes it safe to build a read-only view
(`/admin/operations`'s bounded, newest-first, 50-row tail) directly on top
of without a separate redaction pass. Logged actions: source
create/update/delete, external-assessment create/update/delete, category
update, ad/AI settings update, manual ingestion trigger.

**Global admin-login rate limiting**
(`src/lib/adminLoginRateLimit.ts`). The pre-existing per-IP limiter
(10 attempts / 5 min / IP) is defeated entirely by an attacker who
rotates or spoofs their source IP. A second, process-global budget (30
attempts / 5 min, deliberately more generous so a legitimate admin's own
typos are never at risk) now runs alongside it on every login attempt,
regardless of source IP — closing that gap for a single running process.
Like every other rate limiter in this app, it is in-memory and
per-process: it resets on restart and is not shared across multiple app
instances. See DEPLOYMENT.md for the reverse-proxy requirement this (and
the pre-existing per-IP limiter) both still depend on.

**Failure isolation.** `/admin` and `/admin/operations` fetch their
optional sections (billing status, ingestion liveness, the audit-log
tail) via `Promise.allSettled`, independently of the page's own required
counts — a transient failure in one optional aggregate renders that one
section as "temporarily unavailable" rather than failing the whole page.
No public-facing route or module imports `adminAudit`/`adminStatus`/
`adminLiveness` — the admin panel is purely a reader of existing tables,
never a dependency the public site's own request path waits on.

**A genuine defect found and fixed during this phase's adversarial
review**: every page under `/admin/(protected)` — including ones
untouched by this phase (`/admin/sources`, `/admin/feed-health`) — was
being statically prerendered at build time by Next's default
optimization, because auth is enforced by middleware rather than by a
`cookies()`/`headers()` call inside the page itself, leaving nothing in
the render path to force dynamic rendering. In a `next build && next
start` deployment this would have frozen every admin page's data
(including the new billing/ingestion visibility this phase exists to add)
at build time. Fixed by adding `export const dynamic = "force-dynamic"`
to every admin page that reads live data.

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
- Expired/revoked `AuthSession` rows aren't pruned by anything — they're
  already inert (`resolveSessionUser` rejects them), just not deleted, so
  the table grows unboundedly. A periodic cleanup (cron or a check on
  write) is a natural addition once session volume makes it worth it.
- A crash between Stripe successfully creating a customer and Veriqen
  persisting that customer id to `User.externalCustomerId` leaves a rare
  orphaned Stripe customer with no local record — an accepted, narrow MVP
  tradeoff (Phase 12A's own audit reasoning), not something Phase 12B
  guards against with a reconciliation job.
- ~~A user who completes TWO separate Checkout Sessions for the same plan
  would genuinely be charged twice~~ — closed by a pre-merge hardening
  pass on Phase 12B (the `CheckoutIntent` table in
  `src/lib/billing/checkoutIntent.ts`): a concurrency-safe reservation
  gate gets exactly one caller to Stripe for a genuinely new attempt, and
  a legitimate retry reuses the same attempt-scoped idempotency key. See
  that module's own doc comment for the full design.
- Account deletion doesn't exist anywhere in this app yet (Phase 12A's own
  audit confirmed this). Whenever it is built, it MUST cancel any active
  Stripe subscription as part of the same deletion flow — this is a locked
  precondition for that future feature, not something Phase 12B needed to
  solve since the feature it would apply to doesn't exist.
- ~~No admin UI surfaces billing state~~ — Phase 13B's `/admin/operations`
  page now shows configured/mode/reason, local subscription counts by
  status, and a never-synced-by-Stripe count, all read-only (see the
  Admin operations section below).
- Admin identity is still one shared password with no per-admin
  attribution (Phase 13A's own audit conclusion, deliberately not solved
  in Phase 13B) — the new `AdminAuditLog` records THAT a mutation
  happened, never WHO performed it, because there is currently no "who"
  to record.
- The new process-global admin-login rate limiter
  (`src/lib/adminLoginRateLimit.ts`), like the pre-existing per-IP one, is
  in-memory and per-process — it resets on restart and is not shared
  across multiple app instances/replicas behind a load balancer. See
  DEPLOYMENT.md for the reverse-proxy `X-Forwarded-For` requirement both
  limiters depend on.
- `duplicate_subscription_conflict` (Phase 12B's webhook-side defense
  against an unexpected second Stripe subscription) remains server-log-only.
  Phase 13B's `AdminAuditLog` records admin MUTATIONS, not Stripe webhook
  events, and Phase 12B's own webhook semantics were deliberately left
  untouched — persisted billing-incident tracking is a candidate for a
  later phase if production experience justifies it.
- `AdminSetting`'s `PUT /api/admin/settings` route fully replaces (never
  merges) the stored `"ads"`/`"ai"` JSON value. The real admin UI always
  submits the complete object it just read via `GET`, so this is never
  triggered through the actual settings page — but a direct API call with
  a partial `ai`/`ads` body would silently drop the other fields back to
  their schema defaults. Pre-existing since before Phase 13B (not
  introduced by the Story Brief kill switch); noted here because it now
  sits directly next to that toggle.
- `storyBriefTimeoutMs` remains environment-only; there is no admin UI to
  change it in this release (Phase 13A's own scope decision).
