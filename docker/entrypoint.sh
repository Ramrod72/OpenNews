#!/bin/sh
set -e

echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy

echo "[entrypoint] syncing categories/sources from config/..."
npm run db:seed

echo "[entrypoint] starting: $*"
exec "$@"
