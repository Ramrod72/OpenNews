# Security

## Reporting a vulnerability

Please open a private report via GitHub's "Report a vulnerability" flow
(Security tab → Advisories) on this repository, rather than a public issue.
If that isn't available, open an issue asking a maintainer to contact you
privately, without details of the vulnerability itself.

Include: affected version/commit, reproduction steps, and impact. You
should get an initial response within a few days.

## Threat model

Veriqen fetches and displays content from external, untrusted sources
(RSS/Atom feeds run by third parties). The core security assumption is:
**everything that comes from a feed is untrusted input**, including
headlines, excerpts, author names, image URLs, and the feed XML itself.

What's in scope:

- A malicious or compromised feed trying to inject script/HTML into pages
  other users view.
- A malicious or compromised feed trying to make the server fetch or leak
  internal network resources (SSRF).
- Abuse of the public search/story API endpoints.
- Unauthorized access to the admin panel or its API.
- Cross-site request forgery against admin actions.
- Unauthorized access to a consumer account, or to another user's data
  through it; privilege escalation between the Free/Basic/Pro plans;
  cross-site request forgery against consumer account actions; consumer
  and admin auth interfering with or being mistaken for each other.
- Unauthorized creation/modification/deletion of source-profile metadata
  or external assessments; cross-source tampering (editing/deleting an
  assessment via an id that belongs to a different source); unsafe
  content (HTML/script) stored in admin-entered profile or assessment
  fields; Veriqen presenting a third party's rating as its own
  determination, or as a source's without disclosing who made it.
- Provenance extraction (Phase 7B) expanding the SSRF/network attack
  surface; a corrupted/hand-edited alias or observation row degrading into
  an unbounded content-retention path; a low-confidence guess being
  persisted or presented as established provenance; a flood of repeated
  attribution phrases in one article inflating that table without bound.
- Source-group/origin-reasoning (Phase 8B) expanding the network attack
  surface, ever persisting a graph, or degrading into unbounded pairwise
  comparison work as a cluster grows; shared-source grouping being
  mistaken for, or presented as, proof of identical origin.
- Coverage Comparison / claim extraction (Phase 10B) expanding the network
  attack surface; an unbounded per-article claim table; unbounded
  pairwise claim comparison as a cluster grows; a raw internal id
  (especially a `ProvenanceEntity` id, which has no legitimate
  consumer-facing use anywhere in the app) leaking into a client payload;
  repetition being presented as, or confused with, corroboration.
- AI Story Brief (Phase 11B): a publisher (via headline/claim/entity text)
  prompting the model to overclaim, leak a reference id it was never
  given, or emit forbidden truth/bias language; a hallucinated or
  malformed model response reaching a viewer; a quota-reservation race
  letting concurrent requests exceed a user's monthly AI quota; a cache
  hit or a failed/rejected generation still consuming quota; internal
  database ids, another user's identity, or full article/feed text
  reaching the model's payload or an application log; the AI provider
  network call becoming a new SSRF/denial-of-wallet surface; an AI
  section failure breaking any other part of the story page.
- Stripe billing (Phase 12B): a forged, replayed, duplicate, or
  out-of-order webhook mutating subscription state; a webhook event being
  marked processed despite its own local synchronization failing;
  price/plan/user/customer/subscription identity tampering from the
  client; an open redirect via the checkout/portal return URLs; CSRF
  against the checkout/portal endpoints; a second paid subscription being
  created for an already-paid customer; entitlement logic failing open for
  an unrecognized subscription status; the checkout success redirect
  itself being trusted as proof of payment; test-mode and live-mode Stripe
  configuration being silently cross-mapped; the Stripe secret key,
  webhook signing secret, or a full webhook payload reaching a log line;
  a Stripe outage taking down unrelated parts of the app because an
  ordinary entitlement check depended on reaching Stripe synchronously.

What's explicitly out of scope for this project's own hardening:

- The accuracy or trustworthiness of a feed's _content itself_ (that's a
  judgment call for whoever configures which feeds to trust — see
  `config/README.md`).
- Availability of third-party feeds (feed downtime is handled gracefully,
  not prevented).

## How each risk is addressed

**Stored/reflected XSS from feed content.** Every string sourced from a
feed (title, excerpt, author) is passed through
`src/lib/security/sanitize.ts`'s `toPlainText`, which strips _all_ HTML
tags — there is no allowlist of "safe" tags to get wrong. The app never
uses `dangerouslySetInnerHTML` anywhere for feed-derived content (grep for
it: the only legitimate use is the admin-configured ad-slot injector, which
only ever renders content an authenticated admin typed in, not feed
content). Image URLs are restricted to `http(s)` via `safeImageUrl`,
rejecting `javascript:`/`data:`/etc.

**SSRF via feed URLs.** `src/lib/security/url.ts`'s `assertPublicHttpUrl`
resolves the feed hostname and rejects loopback, RFC1918 private ranges,
link-local (including the `169.254.169.254` cloud metadata address), and
CGNAT addresses, checking _every_ resolved address to guard against DNS
rebinding. This runs before every feed fetch, as defense in depth — feed
URLs are admin-configured, not directly attacker-controlled, but a
compromised admin session or a copy-pasted malicious URL is still worth
guarding against.

**SQL injection.** All database access goes through Prisma's query builder
with parameterized queries. The one raw query in the codebase
(`prisma.$queryRaw`SELECT 1`` in `/api/health`) takes no input at all.

**CSRF against admin actions.** The admin session cookie is `httpOnly`,
`sameSite: "lax"`, and `secure` in production. Additionally, every mutating
admin API request must include a custom `x-opennews-admin: 1` header
(`src/lib/auth/guard.ts`); this can't be set by a cross-site `<form>`
submission, and a cross-site script attempting to set it would trigger a
CORS preflight the app never approves (no `Access-Control-Allow-Origin` is
configured).

**Admin authentication bypass.** Login compares against
`ADMIN_PASSWORD_HASH` (bcrypt) via `bcryptjs`, or `ADMIN_PASSWORD` with a
constant-time comparison for local dev. If neither is set, login always
fails — there is no default credential. Login attempts are rate-limited
per IP (`src/lib/rateLimit.ts`, 10 attempts / 5 minutes). Access to
`/admin/*` is enforced in `src/proxy.ts` (middleware), which runs before
any page code — not in a layout, which cannot actually block its children
from rendering in the App Router (see ARCHITECTURE.md for the specific bug
this avoids).

**Denial of service / abuse of public endpoints.** `src/proxy.ts` applies a
per-IP rate limit (120 requests/minute) to all `/api/*` routes. This is an
in-memory limiter suitable for a single instance; a multi-instance
deployment behind a load balancer should add a shared limiter (e.g.
Redis-backed) at the reverse proxy layer instead.

**Malicious/oversized feed responses.** Feed fetches have a 15s timeout and
a 5MB response size cap (`src/lib/ingest/fetchFeed.ts`), enforced by
reading the stream incrementally rather than trusting `Content-Length`.

**Security headers.** `next.config.ts` sets `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
a restrictive `Permissions-Policy`, and a Content-Security-Policy that only
allows same-origin scripts/styles by default. **If you enable a third-party
ad network**, you will need to widen `script-src` (and possibly
`frame-src`/`connect-src`) in `next.config.ts` for that network's domains —
the default policy will otherwise silently block it. This tradeoff is
intentional: secure by default, with an explicit, visible step required to
loosen it.

**Secrets.** `.env` is gitignored. `SESSION_SECRET` must be set for the
admin session to work at all in production (an insecure fallback is used
otherwise and a warning is logged). Admin passwords should be stored as a
bcrypt hash, not plaintext, in any deployment beyond local development.

**Consumer password storage.** Passwords are hashed with `bcryptjs` (cost
factor 12) — never stored or logged in plaintext. bcrypt's own 72-byte
input truncation is why the registration/login schemas cap password length
at 72 characters, rather than silently truncating a longer password a user
might reuse elsewhere.

**Consumer session fixation / theft.** `registerUser`/`loginUser` always
mint a brand-new random 256-bit token and a brand-new `AuthSession` row —
there is no code path that "upgrades" a pre-existing (e.g.
attacker-set) cookie value into an authenticated session, which is what
rules out fixation. Only the token's SHA-256 hash is stored server-side
(`AuthSession.tokenHash`); the raw token exists only in the `httpOnly`
cookie and the one response that sets it, so a database read alone can't
recover a working session token. The cookie is `httpOnly` (unreadable from
JS, so immune to being exfiltrated by a feed-derived or third-party XSS
payload even if one slipped past sanitization), `sameSite: "lax"`, and
`secure` in production.

**Consumer/admin auth collision.** The two systems share nothing: separate
cookies (`veriqen_session` vs. `opennews_admin_session`), separate CSRF
headers (`x-veriqen-account: 1` vs. `x-opennews-admin: 1`), separate
session mechanisms (DB-backed opaque tokens vs. `iron-session` encrypted
cookies), and separate middleware guards in `src/proxy.ts`. Regression
tests (`src/lib/auth/password.test.ts`) cover the existing admin
credential check to guard against this work accidentally breaking it.

**CSRF against consumer account actions.** Same approach as admin: every
mutating `/api/account/*` request must include `x-veriqen-account: 1`
(`src/lib/auth/consumer/csrf.ts`), which a cross-site form post can't set
and a cross-site script can't set without triggering a CORS preflight this
app never approves.

**Consumer account enumeration.** Login is fully closed: a wrong password
and a nonexistent email return the exact same `401` and message ("Invalid
email or password."), and a nonexistent email is checked against a fixed
dummy bcrypt hash so the response time doesn't leak which case occurred.
Registration is a deliberate, disclosed exception: a duplicate-email
attempt gets a distinct "already registered" error rather than a generic
one. Genuinely closing that hole requires an email-verification flow (so
the registration response can't tell the browser whether the account was
newly created), and this project has no email-sending infrastructure to
build a real one on — per the project's standing principle of never
faking functionality that doesn't work, a fake "check your email" message
that never actually sends anything is a worse false promise than showing
the error honestly.

**Consumer login brute-forcing.** Login is rate-limited both per-IP and
per-email (`src/lib/rateLimit.ts`, reused from the existing limiter, not
reimplemented) — the per-email limit exists so distributing an attack
across many IPs still can't brute-force one specific account.

**Consumer authorization bypass.** `/api/account` and every consumer
data-fetching path check the session server-side (`getCurrentUser()` /
`resolveSessionUser()`) — hiding a button in the UI is never treated as
sufficient. `/account`, the account page, is additionally gated in
`src/proxy.ts` middleware, for the same reason `/admin` is (see
ARCHITECTURE.md): a `redirect()` called from inside the page component
can't change the HTTP status code once the surrounding layout has already
started streaming its 200 response, so on its own it degrades to a
client-side/meta-refresh redirect for an anonymous request rather than a
real `307`. That was confirmed to leak **no** account data in this case
(the redirect happens before the page fetches or renders anything
user-specific), unlike the admin layout bug described in ARCHITECTURE.md
which did leak real data — but middleware closes the gap entirely rather
than relying on that distinction, and gives a real `307` in every case,
matching how `/admin` is already handled.

**Entitlement/plan checks.** All of it goes through
`src/lib/entitlements.ts` rather than ad hoc `user.plan === "pro"` checks
scattered through route handlers, and an unrecognized feature key fails
closed (no access), not open (unlimited) — a typo in a feature key can
only ever take access away, never accidentally grant it.

**No self-service plan changes.** `/pricing` and the account page's
"Upgrade" buttons never call an API — there's no endpoint anywhere that
lets an authenticated user (or anyone else) set their own `Subscription`.
The only code that ever creates one is `registerUser` (Phase 3), which
always assigns the Free plan; there is no corresponding "update my plan"
handler for a client to call instead. `test/pricingNavigationAndSafety.test.ts`
guards this with a structural scan of every file under `src/app/api` for
subscription-mutating code, so a future PR that adds a naive, unauthenticated
"upgrade" endpoint fails CI rather than shipping.

**Plan-aware advertising (Phase 5).** Basic/Pro's "no ads" entitlement is
enforced as an actual absence, not a CSS hide: `AdSlot`/`AdHeadSnippet`
never inject the ad network's HTML/script into the DOM for a viewer whose
plan doesn't allow ads (`can(userId, "ads_enabled")`, the same centralized
entitlement check used everywhere else — never a hardcoded plan-slug
comparison), so a paying subscriber's browser never downloads or executes
third-party ad-provider JavaScript through Veriqen, and the ad network's
own head-loader script (`AdHeadSnippet`) is gated the same way — not just
the visible per-slot placements. This goes one step further than "never
executes": `/api/ads/eligibility` withholds the ad configuration itself
(every slot's code, the head snippet) from an ineligible viewer's
response entirely — `{ adsAllowed: false }` and nothing else — so a
Basic/Pro browser never _receives_ the ad network's snippet text over the
network in the first place, not just never renders or runs it. An earlier
version of this endpoint returned only the eligibility boolean while the
actual snippet text was still passed down unconditionally as a prop for
every viewer (needed for the client ad components to hydrate); an
adversarial review caught this by fetching the homepage's raw HTML as a
Basic-plan viewer with `curl` and finding the configured ad network's URL
present in the server-rendered page source despite it never executing.
Fixed by moving the settings fetch itself behind the same eligibility
gate. The endpoint returns only a boolean, never the viewer's email, user
id, plan name, or subscription id, so nothing new is exposed to the
browser beyond what ad-gating itself requires, and — as always — nothing
about the viewer is templated into an ad snippet before it's injected, so
no personal information reaches an ad provider through this mechanism.
Failure handling is asymmetric on purpose: an anonymous visitor (no
session cookie) keeps normal Free behavior even during a failure, while an
authenticated visitor whose plan can't be resolved (e.g. a database
outage) fails closed (no ads), since they might be paying and the
consequence of guessing wrong differs — see ARCHITECTURE.md for the full
reasoning and `test/adEligibility.integration.test.ts` for the regression
coverage of both directions.

**Source profiles and external assessments (Phase 6).** Every mutating
route under `/api/admin/sources/[id]` — the existing profile-metadata
`PATCH`, and the new assessment `POST`/`PATCH`/`DELETE` — calls
`requireAdmin(req)` first, the same session-and-CSRF guard every other
admin mutation uses; no new auth mechanism was introduced. Assessment
`PATCH`/`DELETE` additionally scope their lookup by **both**
`assessmentId` and `sourceId` (`findFirst({ where: { id: assessmentId,
sourceId } })`) before mutating, so a request naming a real assessment id
that belongs to a _different_ source 404s instead of silently editing
the wrong source's data. Every free-text field an admin can enter
(description, country, ownership, provider, rating value/scale, notes) is
sanitized with the existing `toPlainText()` (the same function feed
content is sanitized with) before being stored — defense in depth, since
nothing in this feature renders these fields via `dangerouslySetInnerHTML`
in the first place, and a structural test (`test/sourceProfileSafety.test.ts`)
asserts none was introduced. Every URL a profile or assessment can carry
(`homepageUrl`, `logoUrl`, `referenceUrl`) is validated with an http(s)-only
Zod refinement (`httpUrl` in `src/lib/validation/sourceProfile.ts`),
rejecting `javascript:`/`data:`/any other scheme before it's ever stored,
so a reference link can't become a stored-XSS vector via `href`.

The public `GET /api/sources/[id]` route requires no authentication (this
data — publisher name, description, third-party ratings — is meant to be
public, same as the existing `/api/sources` list) but its response is
built from an explicit field allowlist (`toPublicSourceProfile()`), the
same "serialize, don't return the raw Prisma row" pattern `serializeCluster()`
already uses for stories — it never returns the feed URL, `active`, or any
ingestion-health field (`fetchIntervalMinutes`, `lastFetchedAt`,
`lastError`, `consecutiveFailures`, ...), and a regression test asserts
this directly on the route's JSON response. An unknown source id 404s
with a generic message; there is no distinct "id well-formed but not
found" vs. "malformed id" response that would help enumerate valid ids.

The external-assessment model has no field, computation, or code path that
combines multiple providers' ratings into a single score — this is a
deliberate design constraint, not an oversight, since averaging conflicting
political-lean or credibility ratings would itself misrepresent both
providers and let Veriqen's presentation imply a false precision or a
determination Veriqen never made. Every assessment requires a non-empty
`provider` at the schema level (`externalAssessmentSchema`), so there is
no way, even for an admin, to store an anonymous/unattributed rating.

**Provenance extraction foundation (Phase 7B).** The deterministic
attribution extractor (`src/lib/provenance/`) introduces **zero new
outbound network fetches**: it operates entirely on text the existing
ingestion pipeline already fetched and sanitized. It never fetches a
publisher's article page, never follows a link found inside an article,
and never refetches a historical feed to reconstruct text the database no
longer has — the explicitly-invoked backfill script
(`worker/backfill-provenance.ts`) works only from stored `title`/`excerpt`
values. `src/lib/security/url.ts`'s `assertPublicHttpUrl` (the SSRF guard)
is not modified, extended, or weakened anywhere in this phase; a
structural regression test (`test/provenanceBoundary.test.ts`) asserts no
provenance module calls `fetch()` or imports the SSRF guard at all, and
that `fetchFeed.ts`'s own guarded fetch call count is unchanged.

Every string the extractor reads (`Article.title`, the transient sanitized
feed text, `Article.excerpt`) has already passed through
`toPlainText()` — the same untrusted-feed-content sanitization every
other ingested field goes through — before extraction ever sees it; the
extractor introduces no new parsing of raw/HTML feed content. A resolved
observation's `evidenceText` is a bounded-length snippet of the matched
clause only (never the surrounding excerpt/feed text in full, never
copied into more than one place beyond that snippet), and the fuller
sanitized feed text a new article's extraction analyzes is discarded
immediately after use — it is never written to any column, cache, or log
in a form a later read could recover as a full-text copy of the original
feed item, so this phase does not expand what publisher content Veriqen
retains beyond the ~220-character excerpt it already stored before this
phase existed.

**Confidence is enforced, not just recommended.** Phase 7B's precision
policy — false negative over false positive — is a locked product
decision, not merely documentation: `persistObservationsForArticle`
(`src/lib/provenance/persistObservations.ts`) filters out any `LOW`-
confidence candidate before it reaches a database write, so
`ProvenanceObservation.confidence` can only ever be `HIGH` or `MEDIUM` in
storage regardless of what the extractor internally considers. This is
directly regression-tested (`test/provenanceIngestion.integration.test.ts`),
including a case built specifically to produce an internal `LOW`
classification and confirm it never reaches the table.

**No provenance data is exposed anywhere yet.** No API route, admin page,
or public-facing UI component reads or renders `ProvenanceObservation`,
`ProvenanceEntity`, or `ProvenanceAlias` in this phase — a structural test
scans `src/app/api`, `src/app/admin`, and every UI component for exactly
this. There is consequently no new admin-authorization or public-exposure
surface for this data to audit yet; that arrives with whichever future
phase adds the first read path.

**Defensive observation cap (Phase 8B).** `persistObservationsForArticle`
now enforces a hard maximum of `MAX_OBSERVATIONS_PER_ARTICLE` (20)
auto-generated `ProvenanceObservation` rows per `(articleId,
extractorVersion)`, regardless of how many separate calls the same article
receives (title, then feed text, at ingestion). Without this, a hostile or
malformed feed item that repeats an attribution phrase hundreds or
thousands of times would have passed every existing confidence/dedupe
guard and still written one row per repetition, unboundedly inflating this
table for a single article — a resource-exhaustion vector this phase
closes. The cap is idempotent (a rerun re-upserts the same already-kept
rows rather than consuming fresh budget) and never counts, deletes, or
otherwise touches an `ADMIN_OVERRIDE` row; regression-tested with an
adversarial flood of hundreds of repeated phrases, an exactly-one-over-the-
limit case, HIGH-vs-MEDIUM prioritization at the boundary, and
`ADMIN_OVERRIDE` survival (`test/provenanceObservationCap.integration.test.ts`).

The budget check (reading what's already persisted) and the writes that
consume that budget run inside one `prisma.$transaction`, closing a
concurrency gap a subsequent adversarial review found: without this, two
concurrent calls for the same `(articleId, extractorVersion)` could each
read the same stale pre-write count and collectively persist well past the
cap (empirically confirmed: two concurrent calls, 15 candidates each,
collectively wrote 30 rows before this fix). The realistic worst case this
codebase's own call sites can produce — two concurrent calls on the same
article, e.g. live ingestion overlapping a manually-triggered backfill
touching the same article — is now regression-tested and holds reliably.
At artificially higher concurrency (5+ simultaneous calls on the same
article, not reachable through any current call site), SQLite's
single-writer contention can hit the transaction's timeout; every racing
call then rejects outright rather than the cap being violated, and every
caller already isolates this per-article/per-call (`ingestSource.ts`'s
`extractAndPersistProvenance`, `backfill-provenance.ts`'s
`processArticle`, both pre-existing Phase 7B try/catch boundaries), so
that failure mode is fail-closed, never a crash, and never a cap
violation — an accepted residual risk given SQLite's concurrency model,
explicitly not addressed with a schema/architecture change per this
phase's locked scope.

**Source-group / origin-reasoning foundation (Phase 8B).**
`src/lib/graph/` (`getClusterOriginSummary`, `buildSourceGroups`,
`excerptSimilarity`) introduces **zero new outbound network fetches** —
every function in this namespace is a pure, in-memory computation over
data Phase 7B already persisted, or a bounded read-only Prisma query
against it. It never fetches anything, never parses raw HTML, and never
touches `assertPublicHttpUrl`; this is enforced by a dedicated boundary
test alongside Phase 7B's own network-boundary tests. It also introduces
**no persisted graph**: there is no new Prisma model, no migration, and no
`InformationOriginGroup`/`OriginGroupMember`/`SourceGraphEdge`/`GraphEdge`/
`ReportingRelationship` table — every `ClusterOriginSummary` is derived
fresh, at query time, from a `StoryCluster`'s current article/observation
state, and calling `getClusterOriginSummary` mutates nothing (regression-
tested by snapshotting row counts before/after the call).

Query shape is deliberately bounded and independent of cluster size:
exactly three Prisma queries per call (a cluster-existence point lookup,
one relational query for the cluster's articles with their source and
`ProvenanceObservation` rows, and one query for the full — small, by
design — `ProvenanceEntity` table), never one query per article or per
observation, and never an explicit article-id `IN` list where a relational
join already does the work. Near-duplicate-excerpt comparison
(`excerptSimilarity.ts`) never compares every article pair in a cluster: it
only runs inside an already-narrowed, single-entity candidate group, and
is skipped entirely (returning no signal, never throwing or hanging) once
that group exceeds `MAX_GROUP_SIZE_FOR_TEXT_COMPARISON` (25) — a
1,000-article cluster that all cites Reuters resolves to one group and
zero pairwise comparisons rather than ~500,000. `mergedIntoId` chain
resolution (`resolveCanonicalEntityId`) is similarly bounded
(`MAX_MERGE_CHAIN_DEPTH`) and cycle-safe (a visited-set check), so a
pathological or cyclic entity-merge chain can never hang the process.

There is still no public API or UI for any of this: no `/api/graph`, no
`/api/provenance`, no admin page, no story-facing component — a dedicated
boundary test (`test/provenanceBoundary.test.ts`) scans for exactly this,
the same pattern Phase 7B's own exposure boundary uses.

`getClusterOriginSummary` only ever loads the current extractor version's
auto-generated observations (plus any `ADMIN_OVERRIDE` row regardless of
version), never mixing in stale rows from before an extractor version
bump that an article hasn't been reprocessed since — closing a data-
integrity gap an adversarial review found (a stale, possibly-since-
corrected observation could otherwise be silently blended into a fresh
group alongside other articles). Near-duplicate excerpt comparison also
excludes any excerpt normalizing to fewer than `MIN_WORDS_FOR_COMPARISON`
(8) words, closing a false-positive risk the same review found: two
merely coincidentally-identical short/boilerplate excerpts (e.g. both a
malformed "Breaking News" placeholder) would otherwise score a perfect
1.0 similarity from almost no real evidence.

**Story Intelligence's client-serialization boundary (Phase 9B).**
`src/lib/storyIntelligenceView.ts`'s `buildStoryIntelligenceView` is the
ONE place `ClusterOriginSummary` is converted into anything a Client
Component (`<EvidenceDrawer>`) can receive, and therefore the one place
that determines what actually serializes into the page's client payload.
The returned shape never contains `observationId`, `entityId`,
`extractorVersion`, `reviewState`, `dedupeKey`, `startOffset`/
`endOffset`, `mergedIntoId`, or any raw confidence enum
(`"HIGH"`/`"MEDIUM"`) — regression-tested directly by asserting none of
these strings appear anywhere in `JSON.stringify(view)`, for both an
entitled and a non-entitled view. `<StoryIntelligence>` (the Server
Component) and `<EvidenceDrawer>` (the one Client Component) both import
only this safe view-model's types, never `@/lib/graph/*` or
`ClusterOriginSummary` — enforced by a structural test alongside the
existing Phase 8B UI-exposure boundary test (`test/provenanceBoundary.test.ts`,
extended for Phase 9B).

Entitlement gating happens in the data itself, server-side, before
anything reaches a Client Component — never via CSS hiding pre-fetched
premium data. A viewer without the `provenance_full` entitlement (Free,
logged-out, or an unentitled account) gets a `StoryIntelligenceView` whose
reporting-source groups are truncated to `MAX_FREE_REPORTING_GROUPS` (2)
and whose `articles`/`evidence` fields are `undefined` on every group —
there is no premium evidence text anywhere in the object for the browser
to ever receive, regression-tested directly (`src/lib/storyIntelligenceView.test.ts`'s
"Free/logged-out client payload contains no premium evidence" suite, plus
a real-database integration test exercising Free/Basic/Pro/logged-out
viewers against `loadStoryIntelligence`). No new entitlement key was
added — this reuses the existing `provenance_full` key already present on
the Basic and Pro plans.

Evidence text renders as plain React text everywhere (never
`dangerouslySetInnerHTML`, confirmed by a structural test scanning every
new component file) — the same "feed content is untrusted, never
rendered as markup" posture Phase 7B's own sanitization already
establishes; a hostile `evidenceText`/article title/entity name displays
harmlessly as literal text. Article links keep the app's existing
external-link convention (`target="_blank" rel="noopener noreferrer"`);
publisher links are always internal Next.js `<Link>`s to
`/sources/[id]`, built only from the article's own already-loaded
`Source.id` — never an arbitrary URL derived from entity/publisher text.

**Article URL scheme sanitization.** Unlike the publisher link above,
`article.url` itself is genuinely untrusted (it ultimately comes from a
publisher's RSS feed), and `normalizeUrl()` only canonicalizes a URL — it
does not reject a non-http(s) scheme. A final-review pass confirmed
`new URL("javascript:alert(1)")` parses without throwing, and that no
existing ingestion step rejects it either, so a malicious or compromised
feed could in principle place a `javascript:`/`data:`/`vbscript:` URL in
`Article.url`. `storyIntelligenceView.ts` now runs every article URL
through `safeHttpUrl` (`src/lib/security/sanitize.ts` — the same http(s)-
only allowlist `safeImageUrl` already used for feed-supplied image URLs,
refactored to share one implementation) before it's ever included in the
view model; a non-http(s) URL becomes `""`, and `EvidenceDrawer` renders
that case as plain, non-clickable text rather than an `<a href>`.
Regression-tested at both the mapper level (`storyIntelligenceView.test.ts`)
and end-to-end against a real persisted `javascript:` URL
(`test/storyIntelligence.integration.test.ts`-style scenario exercised
manually during this review).

**Entitlement-lookup failure fails closed, without hiding available data.**
`loadStoryIntelligence` gives the entitlement check (`can()`) its own
try/catch, separate from `getClusterOriginSummary`'s: if `can()` throws
(a transient entitlement-service failure, a malformed plan/subscription
row), `hasFullAccess` resolves to `false` — the Free/logged-out
experience — rather than either accidentally granting full provenance
access or hiding sourcing data that loaded successfully. Regression-tested
against the real orchestrator with `@/lib/entitlements`'s `can` mocked to
reject (`test/storyIntelligenceEntitlementFailure.integration.test.ts`).

A single reporting-source group is bounded to `MAX_ARTICLES_PER_GROUP_DISPLAY`
(50) displayed articles/evidence rows regardless of the group's true
size, closing a giant-array rendering/payload-size risk this review
specifically checked for (Phase 8 itself is tested against 1,000-article
clusters). `articleCount` itself is never truncated — only the rendered
list is bounded, and `EvidenceDrawer` discloses the truncation ("Showing
50 of 127 articles") rather than letting the true count next to a shorter
list imply completeness. A second, TOTAL cap
(`MAX_EVIDENCE_ITEMS_PER_GROUP`, 100) additionally bounds the flattened
evidence list per group — the per-article cap (5) times the per-group
article cap (50) times the 200-character evidence-text cap could otherwise
expose up to ~50,000 characters of publisher-sourced text for one expanded
group, well past what "supporting evidence for a citation" should mean.

No new network fetch, no schema change, no migration, and no new public
API were introduced: Story Intelligence lives entirely on the existing
`/story/[slug]` canonical route, calling `getClusterOriginSummary`
directly from server code exactly as Phase 8B intended, with zero new
`fetch()` calls anywhere in the new files (structurally confirmed).

**Coverage Comparison's client-serialization boundary (Phase 10B).**
`src/lib/coverageComparisonView.ts`'s `buildCoverageComparisonView` is the
ONE place internal `ClaimGroup`/`Claim` shapes (which carry a Claim's
`id`, `entityId`, `startOffset`/`endOffset`, `claimExtractorVersion`,
`reviewState`, `dedupeKey`, and raw confidence enum) are converted into
anything a Client Component (`<ClaimEvidenceDrawer>`) can receive.
Regression-tested by asserting none of those field names appear anywhere
in `JSON.stringify(view)`, at every entitlement tier
(`coverageComparisonView.test.ts`).

An adversarial self-review pass specifically targeting this boundary
found one real defect the field-name check above did not catch: a claim
group's client-visible `key` field (used only for React reconciliation)
was built as `` `${group.kind}-${group.numericUnit ?? group.entityId ?? "x"}-...` ``
— for `ATTRIBUTED_STATEMENT` groups, this embedded the raw
`ProvenanceEntity` id **value** directly into a string sent to the Client
Component's props, which a field-name-only check can't detect (the leak
is a value, not a key named `entityId`). Fixed by building `key`
exclusively from already-consumer-safe fields (kind, a positional index,
numeric fields, and the group's first article id — article ids are
already exposed elsewhere in the same view for internal `/sources/[id]`
routing, unlike a `ProvenanceEntity` id, which is never otherwise
consumer-facing). Regression-tested with a group carrying a distinctive
sentinel entity id, asserting it never appears in `view.claimGroups[0].key`
or anywhere in `JSON.stringify(view)`.

A second defect the same review found: the "N cited by Reuters" source-
overlap line originally joined _every_ overlapping entity's name into one
string while reading only the _first_ entry's `overlapArticleCount` —
if a claim group's `sourceOverlap` ever contained two different entities
with two different counts (e.g. Reuters cited by 9 of 15 articles, AP by
3), the rendered line would misrepresent AP's count as if it were shared
with Reuters. Fixed so every `sourceOverlap` entry renders its own line
with its own count; regression-tested structurally in
`test/coverageComparisonSafety.test.ts`.

Entitlement gating happens in the data itself, before anything reaches a
Client Component — never via CSS hiding pre-fetched premium evidence. A
viewer without `coverage_comparison_full` (Free, logged-out, or an
unentitled account) gets a view whose claim groups are truncated to
`MAX_FREE_CLAIM_GROUPS` (2) and whose `sourceOverlap`/`occurrences` fields
are `undefined` on every group; a viewer with `coverage_comparison_full`
but not `claim_comparison` (Basic) gets `sourceOverlap` but never
`occurrences` (per-article evidence, Pro-only) — regression-tested
directly (`coverageComparisonView.test.ts`'s Free/Basic/Pro suites, plus
a real-database integration test exercising all three tiers plus
logged-out against `loadCoverageComparison`). No new entitlement key was
added — both `coverage_comparison_full` and `claim_comparison` already
existed on the Basic/Pro plans respectively.

**Entitlement-lookup failure fails closed, independently per key.**
`loadCoverageComparison` gives `coverage_comparison_full` and
`claim_comparison` each their own try/catch, separate from the data-
loading try/catch: if either `can()` call throws, that flag resolves to
`false` rather than granting access or hiding data that loaded
successfully — regression-tested against the real orchestrator with
`can` mocked to reject
(`test/coverageComparisonEntitlementFailure.integration.test.ts`).

**No dangerouslySetInnerHTML; hostile text renders as plain text.**
Claim text, headline text, and evidence snippets all render as plain
React text (confirmed by a structural test scanning every new component
file) — hostile HTML/script/Unicode-bidi content in a claim's `rawText`
(ultimately derived from feed-supplied article text) displays harmlessly
as literal text, never as markup. Persistence itself was also
adversarially tested against hostile input (`<script>` tags, quotes,
ampersands, embedded RTL override characters) to confirm it never throws
or corrupts a row.

**Article URLs are scheme-sanitized before they ever reach a Client
Component**, reusing the exact `safeHttpUrl` gate Phase 9B established
(`src/lib/security/sanitize.ts`) for every occurrence/headline-entry
article link; a non-http(s) scheme becomes `""` and renders as plain,
non-clickable text. Publisher links are always an internal Next.js
`<Link>` to `/sources/[id]`, built only from the article's own
already-loaded `Source.id` — never an arbitrary URL.

**Claim-cap enforcement is concurrency-safe.** `MAX_CLAIMS_PER_ARTICLE`
(20) is enforced with the identical transaction shape
`persistObservations.ts` established for Phase 8's own
previously-fixed observation-cap race: the pre-write row count and the
writes that consume the remaining budget both run inside one
`prisma.$transaction`, so two concurrent `persistClaimsForArticle` calls
for the same `(articleId, claimExtractorVersion)` — title extraction and
feed-text extraction both running during the same ingestion request, or
two overlapping backfill-worker batches — can never both read a stale
pre-write count and collectively persist more than 20 rows.
Adversarially tested with two genuinely concurrent calls
(`test/claimPersistence.integration.test.ts`).

**No uncontrolled O(n²) comparison as a cluster grows.**
`NUMERICAL_ASSERTION` grouping needs no pairwise comparison at all (exact
bucket match is both safer and linear); `ATTRIBUTED_STATEMENT` grouping
buckets by canonical entity first and skips text-similarity comparison
entirely for any bucket larger than `MAX_GROUP_SIZE_FOR_TEXT_COMPARISON`
(25) — the same defensive cap shape `excerptSimilarity.ts` already
established for Phase 8. Verified against a 1,000-claim single bucket
completing well inside the test's time budget with zero pairwise
comparisons (`buildClaimGroups.test.ts`).

**Repetition is never presented as corroboration.** This is the phase's
central epistemic-safety property, and it is checked three ways: (1)
structurally, `computeSourceOverlap` returns a field that is never
subtracted from or combined with `articleCount` anywhere in the
codebase; (2) by a real-database integration test asserting both facts
are exposed separately for a cluster where every article genuinely does
cite Reuters (`test/coverageComparison.integration.test.ts`); and (3) by
a semantic-regression suite that greps every Coverage-Comparison-related
source file for a list of specifically forbidden affirmative phrasings —
"N sources independently confirmed," "verified the claim," "corroborated
the story," "same dispatch," "plagiarized," "did not report," "failed to
report," and others — while still permitting those same underlying words
inside a negated disclaimer sentence explaining what Veriqen does _not_
claim (`test/coverageComparisonSafety.test.ts`).

**Copyright/text-display bounds.** Representative claim text and
occurrence text are bounded to `MAX_CLAIM_TEXT_LENGTH` (~200 characters)
at persistence time; occurrences per group are capped at
`MAX_OCCURRENCES_PER_GROUP_DISPLAY` (50); claim groups displayed are
capped at `MAX_CLAIM_GROUPS_DISPLAYED` (50, Basic+) or
`MAX_FREE_CLAIM_GROUPS` (2, Free) — short structured assertions only,
never large quantities of copied publisher text.

**Zero new network fetch, one additive migration, no new public API.**
Coverage Comparison lives entirely on the existing `/story/[slug]`
canonical route; a structural test confirms no `/api/claims`,
`/api/coverage`, or `/api/coverage-comparison` route exists and that no
API route file references any Coverage Comparison internals. The one
schema change (`Claim`, plus its relations on `Article` and
`ProvenanceEntity`) was verified against a populated pre-Phase-10B
database snapshot (5 articles, a story cluster, provenance observations)
migrated forward with zero data loss on every pre-existing table, and the
new `Claim` table/relation confirmed functional immediately afterward.

**Final adversarial merge-gate review — three additional defects found and
fixed before merge readiness.** A second, independent adversarial pass
against the finished PR (re-reading every file fresh rather than trusting
the review above) found three further real defects:

1. **LOW confidence had no independent guard at the point of persistence.**
   `buildAttributedStatementClaims` copies an `ATTRIBUTED_STATEMENT`
   claim's confidence straight through from a caller-supplied Phase 7
   observation — a plain string column, not a database-enforced enum —
   and `persistClaimsForArticle` had no runtime check rejecting a
   non-HIGH/MEDIUM value before writing it, relying entirely on trusting
   that Phase 7's own filtering never regresses and no row is ever
   hand-edited. Reproduced by constructing an observation with
   `confidence: "LOW"` (bypassing the TypeScript type) and confirming it
   persisted verbatim. Fixed by reusing `isPersistableConfidence`
   (already exported from `src/lib/validation/provenance.ts` and already
   used by `persistObservations.ts`) as an independent filter at the
   claim-persistence boundary, with a new `discardedLow` counter for
   observability.
2. **Single-linkage transitivity could merge dissimilar attributed
   statements.** `groupAttributedStatements` previously used union-find
   over any pair of claims clearing `SIMILARITY_THRESHOLD`, which means
   three claims A/B/C where `sim(A,B)` and `sim(B,C)` both cleared the
   threshold but `sim(A,C)` did not would still land in one group via B —
   presenting two materially different statements as "the same common
   assertion." Reproduced with an engineered token set verified against
   the real `cosineSimilarity` implementation (`sim(A,B)=0.676`,
   `sim(B,C)=0.676`, `sim(A,C)=0.399`, all below/above threshold as
   labeled). Fixed by switching to deterministic **complete-linkage**
   clustering: a claim only joins an existing cluster when it clears the
   threshold against **every** member already in that cluster, never
   merely one — the same bound (`MAX_GROUP_SIZE_FOR_TEXT_COMPARISON`)
   keeps this just as cheap as the single-linkage version it replaced.
3. **A numeric range or a hostile negative sign silently collapsed to a
   false-precise value.** `"10-12 people were injured"` extracted as an
   `EXACT` claim of `12` (silently discarding the range's lower bound),
   and `"-5 people were injured"` extracted as `5` (silently discarding
   the sign) — both present text that never asserted one definite
   positive number as if it had. Fixed by refusing extraction whenever a
   `-`/en-dash/em-dash is immediately adjacent (no intervening space) to
   the matched digit run.

All three are permanently regression-tested
(`test/claimPersistence.integration.test.ts`,
`src/lib/claims/buildClaimGroups.test.ts`,
`src/lib/claims/extractNumericalAssertions.test.ts`). The same review
additionally re-verified, via fresh direct attack rather than re-reading
prior results: `safeHttpUrl` against every scheme/whitespace/credential/
encoding trick relevant to this phase's new hrefs (all correctly
rejected); a sentinel-value serialization sweep placing distinctive
values in a claim's `id`, `entityId`, and a hostile confidence string,
confirmed absent from the serialized view at all three entitlement tiers;
and a 20,000-claim grouping stress test (1,000 articles × 20 claims
across 50 distinct buckets) completing in ~31ms with correct results.

**AI Story Brief (Phase 11B).** This is the first feature in the codebase
that calls a language model, so its security model is documented
separately and in more depth than a typical phase.

_Prompt injection._ Every publisher-controlled string (headline, claim
text, occurrence text, entity/source names) is treated as hostile.
System instructions and the untrusted data payload are kept in
structurally separate chat-API roles (`ollamaProvider.ts`), and the
instructions explicitly tell the model the data block is never an
instruction. This is deliberately documented as defense-in-depth, not the
real boundary — a model can still be influenced by hostile text
regardless of which role it arrived in. The actual security boundary is
output validation (`storyBrief/schema.ts`), which runs unconditionally on
every response: a simulated "compromised" model that fell for an injected
instruction and wrote the forbidden word "reliable" is still rejected,
because validation checks the model's words, not its intentions (see
`test/aiStoryBrief.integration.test.ts`'s "M/N" and "AA/AB" cases).

_Invented/hallucinated references and epistemic overclaim._ A model
output's `refs[]` may only cite ids from the exact closed set the server
built for that one request (`collectValidReferences()`); any other id —
even one that looks plausible, like `CLAIM-GROUP-99` — is rejected
(`test/aiStoryBrief.integration.test.ts`'s "T/U"). A separate, independent
runtime language-policy validator (`languagePolicy.ts`) rejects the exact
forbidden-term list (confirmed, verified, corroborated, true, false, lie,
proved, disproved, biased, reliable, omitted, hid, failed to report, same
dispatch, copied, plagiarized, independently confirmed, and negated
variants like "unverified") regardless of what the system prompt already
forbids — this is deliberately stricter and independent of prompt
engineering, since this feature's narrow job never legitimately needs
these words in any form.

_Reference/id/user-data leakage._ The reference ids the model sees are
ephemeral and per-request, never a database id. The data payload sent to
the provider is built only from already-Pro-safe view models and is
tested to contain no cuid-shaped internal id and no `userId`/email
(`test/aiStoryBrief.integration.test.ts`'s "AI/AJ"). Application logs
(`console.error` calls in `storyBrief/generate.ts`) log only an internal
`storyClusterId` and an exception object, never the built prompt, data
payload, or model output — tested directly by spying on `console.error`
and asserting the logged text never contains distinctive headline/claim
text ("AK/AL").

_Quota race and denial-of-wallet._ `reserveUsage()`/`releaseUsage()`
(`src/lib/entitlements.ts`) reserve a quota unit inside one
`prisma.$transaction` before any provider call, and release it if the
call fails or its output fails validation — a cache hit, an entitlement
failure, disabled config, or insufficient input never touches quota at
all. Concurrency safety is adversarially tested with genuine concurrent
database writes: remaining quota of 1 with 2 simultaneous requests admits
at most 1 new reservation, and remaining quota of 2 with 5 simultaneous
requests admits at most 2
(`test/aiStoryBriefQuotaRace.integration.test.ts`, "J"/"K"). A per-user
rate limit and single-flight deduplication bound how often a single user
can trigger a real provider call in the first place.

_Cache poisoning/staleness._ The cache key includes `inputFingerprint`
(a hash of the exact bounded input), `promptVersion`, `provider`, and
`model` — any change to any of these (a new article, changed claims, a
prompt rewrite, a model upgrade) produces a cache miss rather than
serving stale content; there is no separate invalidation path that could
fall out of sync (`test/aiStoryBrief.integration.test.ts`'s "AM"/"AN"/
"AO"). Nothing ever writes to the cache except a response that has
already passed full output validation, so a poisoned or malformed
response can never be cached.

_Oversized input/output, malformed provider response, XSS/URL injection._
Input is capped well before it reaches the provider (`input.ts`'s
per-array and per-item caps). The provider response itself is read with a
bounded reader (`readBodyWithLimit`, fixing the gap Phase 11A identified
in the older `ollama.ts`'s unbounded `res.json()`) and is rejected as
oversized before ever being parsed as JSON. All output text is rendered
as plain text (no `dangerouslySetInnerHTML` anywhere in
`AiStoryBrief.tsx`), and any URL-like scheme in model output
(`https:`, `javascript:`, `data:`, etc.) is rejected outright — the
feature never renders a model-supplied link.

_Provider timeout/network failure/429, fail-open behavior._ Every
provider failure mode (`timeout`, `network_error`, `provider_error`,
`empty_response`, `oversized_response`) is treated identically: the
reservation is released and the result fails closed to `unavailable`,
never fails open to showing unvalidated content
(`test/aiStoryBrief.integration.test.ts`'s "H"/"AC/AD"/"AE/AF").

_Provider network boundary._ The AI provider endpoint is an
operator-configured fixed address (`AdminSetting`/env, the existing AI
config precedent), with redirects disabled and a bounded timeout — this
is a deliberately different trust boundary than the publisher-facing SSRF
guard (`assertPublicHttpUrl`) and does not alter that guard's own
architecture; an operator who configures their own AI endpoint is not the
same threat as an attacker-controlled feed URL.

_Failure isolation / old-pipeline regression._ A thrown error anywhere in
generation (including a provider that throws instead of returning a
failure response) resolves to `unavailable` rather than propagating
(`test/aiStoryBrief.integration.test.ts`'s "AH"). The pre-existing
`StoryCluster.summary`/`refreshSummaries()` pipeline is never read or
written by this feature (`"AQ"`), and the full Phase 7-10 regression
suite (provenance, source-groups, claims, coverage comparison, story
intelligence — 26 files, 375 tests) passes unchanged alongside Phase
11B's own suite.

**Stripe billing (Phase 12B).** The webhook endpoint is this feature's
highest-risk trust boundary; the rest of the risks below cluster around
identity/price tampering and fail-closed entitlement resolution.

_Forged/replayed/duplicate/out-of-order webhooks._ Every webhook request
is signature-verified (`BillingProvider.verifyWebhookEvent`) before a
single payload field is trusted — an invalid or missing signature is
rejected with no database work at all
(`src/lib/billing/stripeProvider.test.ts`'s "J"/"K", real signature
verification against a test-only secret, no network call). Duplicate or
replayed delivery of the same event id is idempotent
(`test/billingWebhookSync.integration.test.ts`'s "L"/"M", including a
genuinely concurrent double-delivery race). Out-of-order delivery cannot
regress state because every handler re-fetches the CURRENT subscription
from Stripe rather than trusting the event's own embedded snapshot
(`"N"`).

_Event marked processed despite failed synchronization (Amendment C)._
`ProcessedWebhookEvent` is written only inside the same
`prisma.$transaction` as the `Subscription` write — a synchronization
failure rolls back both, so the event is never falsely marked processed
and Stripe's retry can fully reprocess it later, proven by directly
injecting a transaction failure and confirming (a) no event/row was
written, and (b) an identical subsequent call, against a healthy
database, fully succeeds
(`test/billingWebhookSync.integration.test.ts`'s "AW"/"AX"/"BG"/"BH").

_Price/plan/user/customer/subscription identity tampering._ A client may
supply only a closed plan-slug enum (`"basic"` | `"pro"`) to Checkout —
never a price id, customer id, or subscription id
(`src/lib/billing/planMapping.ts`'s `isPaidPlanSlug`, tested against
type-confused and injection-shaped inputs). All other identity (which
user, which Stripe customer, which subscription) is resolved
server-side from the authenticated session or the verified webhook's own
re-fetched Stripe object — there is no request field anywhere in
`checkout.ts`/`portal.ts`/`webhookSync.ts` a caller could use to name a
different identity (`test/billingRoutes.integration.test.ts`'s
ownership tests, `test/billingWebhookSync.integration.test.ts`'s
unknown-customer/unknown-price fail-closed tests).

_Open redirect._ Checkout's `successUrl`/`cancelUrl` and the Portal's
`returnUrl` are built exclusively from `getSiteUrl()` plus a literal,
hardcoded path — there is no parameter in `createCheckoutForUser`'s or
`createPortalForUser`'s own signature a caller could use to influence
either, making this structurally impossible rather than merely validated.

_CSRF._ Both mutating endpoints require the same `x-veriqen-account: 1`
header convention every other consumer-account route already uses;
missing it is rejected with 403 before authentication is even checked
(`test/billingRoutes.integration.test.ts`).

_Second paid subscription creation._ `createCheckoutForUser` rejects
with `already_subscribed` whenever the caller's current subscription
already grants paid access (per the same status matrix entitlements.ts
uses) — Basic→Pro, Pro→Basic, and a `past_due`-but-still-paid user are
all routed away from a second Checkout Session
(`test/billingCheckout.integration.test.ts`'s "BB"/"BC"/"BD"). Known,
accepted residual risk: two Checkout Sessions opened before either
completes can both succeed, since Checkout intentionally does not lock
against this (ARCHITECTURE.md's Known Limitations).

_Entitlement fail-open for an unrecognized status._ `grantsPaidAccess()`
is an ALLOW-list, not a deny-list — an unrecognized/future Stripe status
string fails closed to "no paid access" by construction, proven directly
(`test/entitlements.integration.test.ts`'s "AZ").

_Checkout success redirect trusted as proof of payment._ Nothing in
`createCheckoutForUser` or the account page's own rendering of
`?checkout=success` ever mutates `Subscription` state — the message is
purely informational; the only code path that ever writes
`Subscription` state is the verified webhook sync
(`test/billingCheckout.integration.test.ts`'s "H").

_Test/live environment confusion (Amendment A)._ `getBillingConfig()`
requires an explicit `STRIPE_MODE` and cross-checks it only against
Stripe's own documented secret-key prefix convention — never against a
Price id's or webhook secret's formatting, which Stripe documents no
convention for at all. A mismatch disables billing entirely rather than
guessing which mode was intended
(`src/lib/billing/config.test.ts`'s "BF").

_Secret/payload leakage in logs._ Every log line in the billing webhook
path carries only a reason code, an event id, or a Stripe object id —
proven directly by asserting the logged text never contains the
configured secret key or webhook secret across a signature-failure path
and a synchronization-failure path, including with a deliberately
hostile payload embedding fake secrets and card numbers
(`test/billingPrivacyAndIsolation.integration.test.ts`'s "AC/AD").

_Stripe outage isolation._ `getPlan()` (`src/lib/entitlements.ts`) never
calls Stripe — it only reads the local `Subscription` row a verified
webhook already synchronized. Proven directly: an active Pro user's
entitlements resolve correctly with no billing provider or config
constructed anywhere in the test at all
(`test/billingPrivacyAndIsolation.integration.test.ts`'s "BA").

_Privacy._ Only an email and an opaque Veriqen user id ever reach the
provider's `createCustomer`/Checkout-metadata calls — proven by asserting
the exact key set on every such call, ruling out any accidental inclusion
of saved-stories/topics/history data that has no field to travel through
in the first place (`"AE"`).

## Dependency scanning

`npm audit` is not run in CI by default; run it locally before releases.
Prisma's own CLI currently pulls in a few optional dev-tooling
sub-dependencies (`@prisma/dev`, `hono`, `mysql2` used by driver adapters
this project doesn't use) that `npm audit` flags — these are not part of
this app's runtime code path (SQLite/Postgres via the standard datasource
URL, not driver adapters), but keep an eye on them when upgrading Prisma.
