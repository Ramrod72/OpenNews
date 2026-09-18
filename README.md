# Veriqen

An open-source, self-hostable news aggregator. Veriqen pulls headlines from
public RSS/Atom feeds, groups articles covering the same event into a single
**story**, and gives readers a timeline, source comparison, and links back to
every original publisher — instead of one more undifferentiated chronological
feed.

It is built to run with **zero mandatory paid services**: no news API, no
search API, no AI API, no hosted database, no analytics platform. A clone and
`docker compose up` gets you a working instance backed by SQLite.

## What it does

- **Ingests public RSS/Atom feeds** on a schedule, with retries, per-source
  health tracking, and graceful handling of feeds that go down.
- **Deduplicates and clusters** articles about the same story (by URL, and by
  TF-IDF similarity over headlines/excerpts) instead of just listing every
  article from every feed.
- **Flags breaking news** only when there's real signal — multiple
  independent sources actively publishing about the same story in a short
  window — never a fabricated label.
- **Builds a timeline and source comparison** for every story, so you can see
  how coverage developed and how different outlets are framing it, without
  Veriqen telling you which one is "right."
- **Summarizes stories automatically** from the collected excerpts
  (extractive, no AI required), with an optional pluggable AI provider
  (self-hosted Ollama-compatible endpoint) for higher-quality summaries.
- **Search and personalization** — keyword search with filters, plus
  bookmarks/followed topics/saved searches stored entirely in the browser
  (no account required).
- **Admin panel** for managing feeds, categories, ad placements, and the
  optional AI provider, protected by a single admin password.
- **Ad slots** as reusable, clearly-labeled placeholder components you wire
  up to whatever ad network you choose — nothing is bundled or hard-coded.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together, and
[config/README.md](./config/README.md) for how feeds and categories are
configured.

## Quickstart (Docker Compose)

```bash
git clone <this-repo-url> veriqen
cd veriqen
cp .env.example .env
# edit .env: set SESSION_SECRET and ADMIN_PASSWORD_HASH (see below)
docker compose up --build
```

Then open <http://localhost:3000>. The `web` service serves the site and
runs `prisma migrate deploy` + seeds `config/sources.json` automatically on
startup; the `worker` service polls feeds on a schedule (default: checks
every 5 minutes, honoring each source's own `fetchIntervalMinutes`).

Generate the two secrets `.env` needs:

```bash
# SESSION_SECRET — used to sign the admin session cookie
openssl rand -base64 32

# ADMIN_PASSWORD_HASH — a bcrypt hash of your chosen admin password
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "your-password-here"
```

The admin panel is at `/admin`.

There won't be any stories on the homepage until the worker has run at
least once — that can take a few minutes on first startup, or you can
trigger an immediate run from **Admin → Dashboard → Run ingestion now**
once you've logged in.

## Local development (without Docker)

Requires Node.js 22+.

```bash
npm install --legacy-peer-deps
cp .env.example .env      # DATABASE_URL="file:./dev.db" works as-is for SQLite
npx prisma migrate dev
npm run db:seed           # loads config/categories.json + config/sources.json
npm run dev                # web app at http://localhost:3000
```

In a second terminal, run the ingestion worker:

```bash
npm run worker             # continuous, polls on a schedule
# or, for a single one-off run:
npm run ingest
```

Other useful scripts:

```bash
npm run lint          # ESLint
npm run format        # Prettier (write)
npx tsc --noEmit       # typecheck
npm test               # Vitest — unit tests + real-SQLite integration tests
npm run db:studio      # Prisma Studio, a GUI for the local database
```

> The `--legacy-peer-deps` flag works around a couple of transitive peer
> dependency ranges from fast-moving packages; there's no actual version
> conflict in this project's own dependencies.

## Tech stack

- **Next.js (App Router) + React + TypeScript** — single deployable app for
  both the UI and its API routes.
- **Prisma + SQLite** by default; swappable to **PostgreSQL** for production
  through configuration only (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
- **Tailwind CSS v4** for styling, with built-in light/dark mode.
- **rss-parser** for feed parsing, **sanitize-html** for stripping all HTML
  out of feed-provided text before it's ever stored or rendered.
- **node-cron** for the ingestion worker's schedule.
- **iron-session** for the admin session cookie; **bcryptjs** for password
  hashing.
- **Vitest** for tests, including integration tests that run migrations
  against a real (temporary) SQLite database.

## Configuring feeds

Feeds and categories are configured in [`config/`](./config), not hardcoded
in application code. See [config/README.md](./config/README.md). They can
also be managed live from **Admin → Sources** without a redeploy.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how ingestion, clustering, and the
  data model work, and known limitations.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Docker, VPS, and PostgreSQL deployment.
- [SECURITY.md](./SECURITY.md) — threat model, hardening decisions, and how
  to report a vulnerability.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute, including
  guidelines for suggesting new feeds.

## What's genuinely optional vs. what's core

The app is fully functional with **nothing** configured beyond a database:
feeds ingest, stories cluster, search works, summaries generate. Optional,
off-by-default add-ons:

- **AI-assisted summaries** (Admin → Settings → AI): point at a
  self-hosted Ollama-compatible endpoint. Falls back to the built-in
  extractive summarizer if unset, unreachable, or slow.
- **Advertising** (Admin → Settings → Advertising): paste a network's
  snippet into a slot and enable it. No ad network is bundled or contacted
  by default.

Nothing in the UI is a non-functional placeholder pretending to be a
finished feature — if something can't work without an external service you
haven't configured, it degrades to an honest empty/disabled state rather
than showing fake data.

## License

See [LICENSE](./LICENSE). The repository owner has not yet selected a
license — that's the one decision this project deliberately leaves to them.
Until a license is chosen, treat this code as all-rights-reserved.
