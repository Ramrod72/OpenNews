# Deployment

## Docker Compose (recommended)

This is the path exercised by `docker-compose.yml`: two containers built
from the same image (`web` and `worker`) sharing a named volume for the
SQLite database file.

```bash
cp .env.example .env
# fill in SESSION_SECRET and ADMIN_PASSWORD_HASH — see README.md Quickstart
docker compose up --build -d
docker compose logs -f
```

- `web` runs `prisma migrate deploy` and seeds `config/` on startup (via
  `docker/entrypoint.sh`), then `npm start` (Next.js production server).
- `worker` waits for `web`'s healthcheck, then runs
  `npx tsx worker/index.ts` — a `node-cron` loop that ingests due feeds and
  re-clusters on the schedule in `WORKER_CRON` (default every 5 minutes;
  each `Source`'s own `fetchIntervalMinutes` still controls how often _that_
  feed is actually fetched).
- Data persists in the `opennews-data` named volume
  (`docker volume ls` / `docker volume inspect opennews_opennews-data`).

To update after pulling new code: `docker compose up --build -d` again —
migrations run automatically on the next `web` startup.

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
npm run db:seed
npm run build
```

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

Put Nginx or Caddy in front of the `web` process (port 3000 by default) to
terminate TLS. Caddy example (`Caddyfile`):

```
your-domain.example {
        reverse_proxy localhost:3000
}
```

Caddy handles Let's Encrypt certificates automatically. For Nginx, use
`certbot --nginx` or your existing TLS setup, and make sure to forward
`X-Forwarded-For` — the admin login rate limiter
(`src/lib/rateLimit.ts`) and the general API rate limiter
(`src/proxy.ts`) key off that header, so a reverse proxy that doesn't set it
correctly weakens both.

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
- **Admin → Dashboard** — article/cluster counts and the 5 most recent
  feed failures at a glance.
