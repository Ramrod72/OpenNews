# Deployment

## Docker Compose (recommended)

This is the path exercised by `docker-compose.yml`: two long-running
containers built from the same image (`web` and `worker`) sharing a named
volume for the SQLite database file, plus a third, one-shot `migrate`
service that applies migrations, sets SQLite to WAL mode, and seeds
`config/` — and nothing else — before `web`/`worker` ever touch the
database.

**`migrate` is intentionally excluded from a bare `docker compose up`** —
it only runs when explicitly invoked with `--profile init`. This is not
a style choice: migrate used to be wired in as a `depends_on` of
`web`/`worker`, and that let Compose re-run it whenever either service
was brought up or recreated **on its own** (e.g. `docker compose up -d
--force-recreate worker` after `web` was already live) — racing a
migration against an already-running process on the same SQLite file and
failing with `"database is locked"`. The fix is architectural, not a
reminder to be careful: Compose itself now refuses to start `migrate` as
a side effect of starting anything else.

**First-time setup** (and after pulling code with new Prisma
migrations):

```bash
cp .env.example .env
# fill in SESSION_SECRET and ADMIN_PASSWORD_HASH — see README.md Quickstart
docker compose build
docker compose --profile init run --rm migrate   # applies migrations, sets WAL, seeds config/ — then exits
docker compose up -d web worker
docker compose logs -f
```

**Restarting/recreating only `worker` (or only `web`)** — the scenario
that caused the original incident — needs no migrate step at all, and
must never include one:

```bash
docker compose up -d --force-recreate worker
```

This only (re)creates the named service; it will not touch `migrate`,
and will not race the database. Run the `migrate` step above first ONLY
when you've actually pulled code with new migrations to apply — not on
every routine restart.

**Before exposing this to real users, put a reverse proxy in front of it
and terminate TLS there (required — Phase 14B).** `docker-compose.yml`
binds the `web` service's port to `127.0.0.1` only, precisely so that
nothing but a reverse proxy on the same host (or another container on
this same compose network, reachable via `http://web:3000` regardless of
the host port binding) can reach it — this app has no TLS of its own and
must never be reached directly, in plaintext, from the public Internet.
See "Reverse proxy + HTTPS" below for the exact Nginx/Caddy configuration
(including the `X-Real-IP`/`X-Forwarded-For` setup every rate limiter in
this app depends on) — it applies identically whether you're running
Docker Compose or the bare-metal path. After it's up, verify from
OUTSIDE the host: `curl -v http://<host-ip>:3000/` should fail to
connect (nothing is listening on that interface/port), and
`https://your-domain.example/` should both succeed and redirect any
plain `http://` request to `https://`.

- `web`'s own entrypoint (`docker/entrypoint.sh`) does nothing but start
  `npm start` (Next.js production server) — it never touches migrations;
  see the `migrate` step above.
- `worker` waits for `web`'s healthcheck, then runs
  `npx tsx worker/index.ts` — a `node-cron` loop that ingests due feeds and
  re-clusters on the schedule in `WORKER_CRON` (default every 5 minutes;
  each `Source`'s own `fetchIntervalMinutes` still controls how often _that_
  feed is actually fetched).
- Data persists in the `opennews-data` named volume
  (`docker volume ls` / `docker volume inspect opennews_opennews-data`).

To update after pulling new code:

```bash
docker compose build
docker compose --profile init run --rm migrate
docker compose up -d --force-recreate web worker
```

### Backups (SQLite)

The whole database is one file. With the containers running:

```bash
docker compose exec web sh -c 'sqlite3 /data/opennews.db ".backup /data/backup-$(date +%F).db"'
docker cp $(docker compose ps -q web):/data/backup-<date>.db ./backup-<date>.db
```

Restoring: stop the stack, replace the volume's `opennews.db` with the
backup file, start the stack again.

## VPS / bare-metal (no Docker)

Requires Node.js 22+ and, for SQLite, no extra services.

```bash
git clone <this-repo-url> veriqen && cd veriqen
npm ci --legacy-peer-deps
cp .env.example .env   # edit DATABASE_URL to an absolute path outside the repo, e.g.
                         # DATABASE_URL="file:/var/lib/opennews/opennews.db"
npx prisma migrate deploy
npm run db:wal      # one-time: puts SQLite in WAL mode (see below)
npm run db:seed
npm run build
```

**`npm run db:wal` (Phase 14B — required once, SQLite only).** The
Docker Compose path runs this automatically on every container start (see
`docker/entrypoint.sh`); the bare-metal path must run it manually, once,
after the first `prisma migrate deploy` against the real database file.
It switches SQLite's journal mode from the default (`DELETE`, the
classic rollback journal) to `WAL`, which lets the `web` and `worker`
processes read and write the shared database file concurrently without
blocking each other — the standard, SQLite-recommended setting for
exactly this "multiple processes, one file" topology. It's idempotent
(safe to re-run any time) and a no-op if `DATABASE_URL` isn't a SQLite
`file:` URL (e.g. after switching to PostgreSQL). See
`scripts/ensure-sqlite-wal.mjs`'s own doc comment for the full
investigation this was based on, including why a `?journal_mode=WAL`
query parameter on `DATABASE_URL` does NOT work with Prisma's SQLite
connector (verified empirically) and must be set this way instead.

Run two long-lived processes (systemd units, or a process manager like
`pm2`):

```
# web
NODE_ENV=production npm start

# worker
NODE_ENV=production npx tsx worker/index.ts
```

Example systemd unit (`/etc/systemd/system/opennews-web.service`):

```ini
[Unit]
Description=Veriqen web
After=network.target

[Service]
WorkingDirectory=/opt/opennews
EnvironmentFile=/opt/opennews/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
User=opennews

[Install]
WantedBy=multi-user.target
```

Duplicate it as `opennews-worker.service` with
`ExecStart=/usr/bin/npx tsx worker/index.ts`.

### Reverse proxy + HTTPS

**Applies to both deployment paths above** — Docker Compose and bare-metal
alike. Put Nginx or Caddy in front of the `web` process (port 3000 by
default, bound to loopback only in `docker-compose.yml` for exactly this
reason) to terminate TLS. Production traffic must never reach this app
directly, in plaintext.

**Trusted-proxy / client-IP model (Phase 14B).** Veriqen's every IP-keyed
rate limiter (admin login's per-IP bucket, consumer login/registration,
billing checkout/portal, the general per-route API limiter — all in
`src/lib/rateLimit.ts`'s `clientIp()`) assumes **exactly one** trusted
reverse proxy sits between the Internet and the app. That proxy MUST do
one of the following — an Internet client can always send its own
`X-Forwarded-For`/`X-Real-IP` values, so if the proxy doesn't correctly
overwrite/append its own view of the connection, an attacker can spoof
whatever client identity they like and rate limiting stops meaning
anything:

1. **Preferred: set `X-Real-IP` to the proxy's own view of the connecting
   peer.** This is an overwrite, not an append, so there is only ever one
   possible value and a client cannot influence it. `clientIp()` reads
   this header first, whenever it's present.
2. **Or: append (never replace) the connecting peer's address as the
   LAST entry of `X-Forwarded-For`.** `clientIp()` reads the RIGHTMOST
   entry of this header — never the leftmost, which is always whatever
   the original client chose to send and must never be trusted.

Caddy example (`Caddyfile`) setting `X-Real-IP` explicitly:

```
your-domain.example {
        reverse_proxy localhost:3000 {
                header_up X-Real-IP {remote_host}
        }
}
```

Caddy handles Let's Encrypt certificates automatically. Nginx example
(use `certbot --nginx` or your existing TLS setup for the certificate
itself):

```
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`$remote_addr` is nginx's own view of the connecting peer (an overwrite,
safe), and `$proxy_add_x_forwarded_for` appends that same peer address as
the last entry of any existing `X-Forwarded-For` (safe, since only the
last entry is ever trusted). **Do not** put a second, additional reverse
proxy or CDN in front of this one unless it also participates correctly
in this chain — an extra untrusted hop would let that hop's own client
input reach the position `clientIp()` treats as authoritative.

Phase 13B's additional process-global admin-login limiter
(`src/lib/adminLoginRateLimit.ts`) doesn't key off any IP at all, so it
isn't affected by any of this — but like every rate limiter in this app it
is in-memory and per-process: behind a load balancer running multiple
app instances/replicas, each instance enforces its own independent
budget, not a shared one.

## Switching to PostgreSQL

SQLite is the zero-config default. For a production deployment with more
write concurrency, higher traffic, or multiple app instances, switch to
PostgreSQL:

1. In `prisma/schema.prisma`, change:

   ```prisma
   datasource db {
     provider = "postgresql"   // was "sqlite"
     url      = env("DATABASE_URL")
   }
   ```

2. Point `DATABASE_URL` at your Postgres instance, e.g.
   `postgresql://opennews:opennews@localhost:5432/opennews`.
3. Regenerate migrations against Postgres (SQLite and Postgres migration
   SQL aren't interchangeable):

   ```bash
   rm -rf prisma/migrations
   npx prisma migrate dev --name init
   ```

4. Rebuild (`npm run build` / `docker compose build`).

The schema was written to avoid SQLite-only types, so no model changes are
needed — only the datasource `provider` and a fresh migration history.
`docker-compose.yml` has a commented-out `postgres` service you can enable
for a self-contained Postgres-backed stack.

## Environment variables

See [`.env.example`](./.env.example) for the full list with descriptions.
At minimum you need `SESSION_SECRET` and either `ADMIN_PASSWORD_HASH`
(recommended) or `ADMIN_PASSWORD` (local dev only) to use the admin panel;
everything else has a working default.

**`SESSION_SECRET` is required in production, with no working fallback
(Phase 14B).** It must be a real, random value of at least 32 characters
(`openssl rand -base64 32` produces one). If it is missing, empty, or
shorter than 32 characters when `NODE_ENV=production`, the admin session
mechanism fails closed: every `/admin/*` page and API route returns an
error instead of ever creating or accepting an admin session. This is
intentional — earlier phases silently signed sessions with a hardcoded,
publicly-visible development-only value in this situation, which would
have let anyone who has read this repository's source forge a valid admin
cookie. The failure is scoped to the admin surface only; the rest of the
site is unaffected by a missing `SESSION_SECRET`. A misconfiguration is
also logged loudly (`[auth] SESSION_SECRET is missing or shorter than 32
characters...`) the first time the app is invoked, so it's visible in
container/process logs at boot rather than only being discovered on the
first admin request.

### Site URL

Set `NEXT_PUBLIC_SITE_URL` to your public origin (e.g.
`https://your-domain.example`, the same domain used in the reverse-proxy
example above) so canonical links, Open Graph/Twitter card previews, and
story share links point at the right place. Without it, these fall back
to `http://localhost:3000`, which is fine for local development but wrong
for anything users will actually see — set it before going live.

### Stripe billing (optional)

Basic/Pro checkout, the Customer Portal, and subscription-status sync are
all dormant until every one of `STRIPE_MODE`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_BASIC_PRICE_ID`, and `STRIPE_PRO_PRICE_ID`
is set (and consistent — see `.env.example`); until then the app behaves
exactly as it did before Phase 12B. To enable it:

1. Create Basic ($4.99/mo) and Pro ($9.99/mo) recurring Prices in the
   Stripe Dashboard (test mode first) and set their Price ids as
   `STRIPE_BASIC_PRICE_ID`/`STRIPE_PRO_PRICE_ID`.
2. Add a webhook endpoint in the Stripe Dashboard pointed at
   `https://your-domain.example/api/billing/webhook`, subscribed to
   `checkout.session.completed`, `customer.subscription.updated`, and
   `customer.subscription.deleted` — set its signing secret as
   `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_MODE` and `STRIPE_SECRET_KEY` to match (both `test`, or
   both `live`) — a mismatch disables billing entirely rather than
   guessing (see ARCHITECTURE.md's Phase 12B section).
4. Redeploy with these variables set (the same `.env`/secret-injection
   mechanism already used for `SESSION_SECRET`).

Stripe retries a failed webhook delivery on its own schedule, so a brief
restart during deployment is self-healing — no special handling is needed
around a rolling restart.

## Monitoring

- `GET /api/health` — checks the database is reachable; used by the Docker
  healthcheck and suitable for an external uptime monitor.
- **Admin → Feed health** — per-source fetch history and current failure
  streaks.
- **Admin → Dashboard** — article/cluster counts, the 5 most recent feed
  failures, and (Phase 13B) a compact ingestion-liveness and billing
  status summary at a glance.
- **Admin → Operations** (Phase 13B) — detailed read-only billing status
  (configured/mode, local subscription counts by status, a
  never-synced-by-Stripe count) and a bounded, newest-first tail of
  recent administrative mutations. No billing mutation of any kind is
  possible from this page or any admin route — Stripe and the Customer
  Portal remain the only place billing state actually changes.
