#!/bin/sh
set -e

# One-shot database initialization: applies pending migrations, ensures
# SQLite is in WAL mode, and syncs categories/sources/plans from config/.
# Runs exactly once per `docker compose up`, from the dedicated `migrate`
# service — NEVER from `web` or `worker` directly (see docker/entrypoint.sh,
# which now does nothing but `exec "$@"`). Running these steps from two
# processes against the same SQLite file at the same time is what produced
# the "database is locked" startup race this script exists to eliminate;
# web/worker's `depends_on: migrate: condition: service_completed_successfully`
# in docker-compose.yml is what guarantees this runs, and finishes, before
# either of them starts.
#
# All three steps are already idempotent (migrate deploy no-ops with
# nothing pending; WAL pragma no-ops if already WAL; db:seed is upsert-based
# — see prisma/seed.ts), so re-running this on every `docker compose up` is
# safe and cheap. It is NOT re-run by Docker's own `restart: unless-stopped`
# policy on an already-created web/worker container (that only restarts
# that container's own main process), which is exactly what lets worker
# auto-restart after a crash with no risk of racing this step.

echo "[migrate] applying database migrations..."
npx prisma migrate deploy

echo "[migrate] ensuring SQLite is in WAL mode (Phase 14B — web+worker concurrency)..."
node scripts/ensure-sqlite-wal.mjs

echo "[migrate] syncing categories/sources/plans from config/..."
npm run db:seed

echo "[migrate] database initialization complete."
