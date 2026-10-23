# Architecture overview

Veriqen News (`opennews` in `package.json`) is a self-hosted news aggregator. A Next.js app serves public and admin pages. A separate worker polls RSS/Atom feeds, stores articles, and groups them into stories. Both processes share one Prisma database. The default database is a SQLite file.

## Application

The web app is Next.js 16 (App Router) with React 19 and TypeScript. UI styling is Tailwind CSS 4 (`postcss.config.mjs`, `src/app/globals.css`). `next.config.ts` only adds baseline security headers.

Routes live under `src/app/`:

- Public pages include the home page, latest, breaking, category, story, search, sources, bookmarks, pricing, about, login, register, and account.
- Admin pages live under `src/app/admin/`, with a login page and a protected area for sources, feed health, operations, and settings.
- Route handlers live under `src/app/api/` (account, admin, stories, sources, search, categories, plans, ads eligibility, billing, and `api/health`).

Shared server logic is in `src/lib/`. `src/lib/db.ts` exports a single `PrismaClient`. Admin auth is a signed cookie (`src/lib/auth/session.ts`, `iron-session`). Consumer accounts use database-backed sessions (`src/lib/auth/consumer/`). Plans and feature quotas are resolved in `src/lib/entitlements.ts`. Optional billing uses Stripe (`src/lib/billing/`). Optional story summaries can call a local Ollama-compatible provider (`src/lib/ai/`).

Seed data for categories, feeds, plans, and provenance aliases comes from `config/` via `prisma/seed.ts` (`npm run db:seed`).

## Data model

`prisma/schema.prisma` uses the SQLite provider and `DATABASE_URL`. Closed value sets are plain strings so the same schema can be pointed at PostgreSQL. SQL history is in `prisma/migrations/`.

| Area | Models |
| --- | --- |
| Ingestion | `Source`, `FeedFetchLog`, `Article`, `Category` |
| Story grouping | `StoryCluster`, `Keyword`, `ArticleKeyword`, `ClusterKeyword` |
| Publisher profile | `ExternalAssessment` (attributed third-party ratings stored on a `Source`) |
| Provenance and claims | `ProvenanceEntity`, `ProvenanceAlias`, `ProvenanceObservation`, `Claim` |
| Accounts | `User`, `AuthSession`, `Plan`, `Entitlement`, `Subscription`, `CheckoutIntent`, `ProcessedWebhookEvent`, `UsageRecord`, `SavedStory`, `UserTopic`, `NotificationPreference` |
| Generated briefs | `AiStoryBrief` (cached, validated output keyed to a `StoryCluster`) |
| Operations | `AdminSetting`, `AdminAuditLog` |

`Article.url` and `Article.urlHash` are unique, which is how ingestion dedupes items. `ProvenanceObservation.dedupeKey` and `Claim.dedupeKey` make extractor reruns idempotent.

## Ingestion worker and scheduler

The long-running process is `worker/index.ts` (`npm run worker` / `npm run worker:start`). It uses `node-cron`. The schedule is `WORKER_CRON`, defaulting to `*/5 * * * *`. A tick is skipped if the previous tick is still running. The process also runs one tick immediately on startup, and exits on `SIGTERM` or `SIGINT`.

Each tick calls `ingestAllDueSources()` in `src/lib/ingest/ingestAll.ts`, then, if any source was fetched, `clusterRecentArticles()` in `src/lib/clustering/cluster.ts`.

`ingestAllDueSources` loads active `Source` rows and keeps those whose `fetchIntervalMinutes` has elapsed since `lastFetchedAt` (or every active source when `force` is set). It fetches up to four sources at a time. One feed failure does not stop the others.

`ingestSource` in `src/lib/ingest/ingestSource.ts` fetches and parses one feed through `src/lib/ingest/fetchFeed.ts` (`rss-parser`, timeout, size cap, and URL checks in `src/lib/security/url.ts`). Items are sanitized (`src/lib/security/sanitize.ts`), normalized (`src/lib/ingest/normalize.ts`), and inserted when the URL hash is new. New articles also get keywords (`src/lib/nlp/keywords.ts`), provenance observations (`src/lib/provenance/`), and claims (`src/lib/claims/`). Each attempt writes a `FeedFetchLog` and updates the source's success or error fields. A single fetch keeps at most `MAX_ITEMS_PER_FETCH` (500) items.

Clustering groups recent articles inside a category with TF-IDF cosine similarity over normalized titles (`src/lib/clustering/tfidf.ts`). Existing clusters stay in place so story URLs remain stable.

Other entry points, all using the same ingest and cluster functions:

- `worker/run-once.ts` (`npm run ingest`) runs one pass and exits. `--force` ignores fetch intervals.
- `POST src/app/api/admin/ingest/route.ts` runs one source or all due sources from the admin UI (`src/app/admin/(protected)/RunIngestButton.tsx`).
- `worker/backfill-provenance.ts` and `worker/backfill-claims.ts` are manual (`npm run backfill:provenance`, `npm run backfill:claims`). They are not on the cron tick. They only read title and stored excerpt already in the database.

SQLite writes from concurrent fetches go through `src/lib/writeQueue.ts`.

## Docker

`Dockerfile` is a three-stage image on `node:22-slim`:

1. `deps` runs `npm ci`.
2. `builder` runs `prisma generate`, `prisma migrate deploy` against a build-time placeholder database, and `npm run build`.
3. `runner` installs production dependencies, copies the Next build, Prisma client, `public/`, `config/`, `worker/`, `scripts/`, `src/`, and `docker/entrypoint.sh` plus `docker/migrate.sh`. It runs as the unprivileged `opennews` user, exposes port 3000, and starts with `npm start`.

`docker/entrypoint.sh` only execs its command. It does not migrate or seed.

`docker-compose.yml` builds one image (`opennews:latest`) and defines three services that share the `opennews-data` volume mounted at `/data` (`DATABASE_URL=file:/data/opennews.db`):

- `migrate` is on the `init` profile (`restart: "no"`, entrypoint `./docker/migrate.sh`). It is not started by a plain `docker compose up`. The script applies migrations, runs `scripts/ensure-sqlite-wal.mjs`, then `npm run db:seed`.
- `web` publishes `127.0.0.1:3000:3000` and healthchecks `http://localhost:3000/api/health`.
- `worker` runs `npx tsx worker/index.ts` after `web` is healthy. Its cron expression is `WORKER_CRON` (default `*/5 * * * *`).

A commented `postgres` service in the same file shows the intended production swap. It is not active. Changing providers still requires editing `prisma/schema.prisma` and regenerating migrations.

## Tests

Vitest (`vitest.config.ts`, `npm test`) runs in the Node environment. It collects `src/**/*.test.ts`, `worker/**/*.test.ts`, and `test/**/*.test.ts`. Files run one at a time against a single SQLite file, `test/.tmp-test.db`. `test/global-setup.ts` deletes that file, applies `prisma migrate deploy`, and deletes it again on teardown.

Colocated `*.test.ts` files cover units such as feed parsing, clustering math, claims, provenance, billing helpers, and auth. Files under `test/` are broader integration checks (ingestion, provenance, billing webhooks, admin audit, rate limits, Docker Compose init, and similar).

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests.

- **Lint, typecheck, build, test** (Node 22): `npm ci`, `prisma generate`, `npm run lint`, `tsc --noEmit`, `npm test`, `prisma migrate deploy`, then `npm run build`. Generate, migrate, and build use `file:./ci-placeholder.db`. Tests use `file:./test/.tmp-test.db`.
- **Docker image builds**: `docker build -t opennews:ci .`
