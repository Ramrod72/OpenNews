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

A single reporting-source group is bounded to `MAX_ARTICLES_PER_GROUP_DISPLAY`
(50) displayed articles/evidence rows regardless of the group's true
size, closing a giant-array rendering/payload-size risk this review
specifically checked for (Phase 8 itself is tested against 1,000-article
clusters). `articleCount` itself is never truncated — only the rendered
list is bounded.

No new network fetch, no schema change, no migration, and no new public
API were introduced: Story Intelligence lives entirely on the existing
`/story/[slug]` canonical route, calling `getClusterOriginSummary`
directly from server code exactly as Phase 8B intended, with zero new
`fetch()` calls anywhere in the new files (structurally confirmed).

## Dependency scanning

`npm audit` is not run in CI by default; run it locally before releases.
Prisma's own CLI currently pulls in a few optional dev-tooling
sub-dependencies (`@prisma/dev`, `hono`, `mysql2` used by driver adapters
this project doesn't use) that `npm audit` flags — these are not part of
this app's runtime code path (SQLite/Postgres via the standard datasource
URL, not driver adapters), but keep an eye on them when upgrading Prisma.
