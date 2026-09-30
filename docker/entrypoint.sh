#!/bin/sh
set -e

echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy

echo "[entrypoint] ensuring SQLite is in WAL mode (Phase 14B — web+worker concurrency)..."
node scripts/ensure-sqlite-wal.mjs

echo "[entrypoint] syncing categories/sources from config/..."
npm run db:seed

echo "[entrypoint] starting: $*"
exec "$@"
