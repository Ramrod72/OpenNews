#!/bin/sh
set -e

# Migrations/WAL setup/seeding are NOT run here anymore — both are run
# exactly once, before web or worker ever start, by the dedicated `migrate`
# one-shot service (see docker/migrate.sh and docker-compose.yml's
# `depends_on: migrate: condition: service_completed_successfully` on both
# web and worker). Running them here too, on every container start, is what
# previously let two processes race a migration/write against the same
# SQLite file at the same time ("database is locked") — see ARCHITECTURE.md.
echo "[entrypoint] starting: $*"
exec "$@"
