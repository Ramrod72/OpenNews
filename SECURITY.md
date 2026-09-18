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

## Dependency scanning

`npm audit` is not run in CI by default; run it locally before releases.
Prisma's own CLI currently pulls in a few optional dev-tooling
sub-dependencies (`@prisma/dev`, `hono`, `mysql2` used by driver adapters
this project doesn't use) that `npm audit` flags — these are not part of
this app's runtime code path (SQLite/Postgres via the standard datasource
URL, not driver adapters), but keep an eye on them when upgrading Prisma.
