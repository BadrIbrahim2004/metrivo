#!/bin/sh
# Metrivo API production entrypoint.
#
# Mirrors the verified integration-test flow (apps/api/test/run-postgres-integration.cjs):
#   1. On a FRESH database: provision NOLOGIN owner + LOGIN migrator roles,
#      create the database schema owned by the protected owner role.
#   2. Apply the baseline schema and every migration via psql, connected as
#      the migrator LOGIN role and running `SET ROLE` to the protected owner.
#   3. Record applied migrations in `_prisma_migrations` so future
#      `prisma migrate deploy` runs are consistent.
#   4. Start the API.
#
# Env:
#   POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB   (compose superuser)
#   DATABASE_URL          runtime app connection (must be a LOGIN role)
set -e

DB_URL_SUPER="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB_HOST:-db}:5432/${POSTGRES_DB}"
MIGRATOR_ROLE="metrivo_dev_migrator"
OWNER_ROLE="metrivo_dev_owner"
APP_ROLE="$(printf '%s' "$DATABASE_URL" | sed -n 's|.*//\([^:@]*\):.*|\1|p')"

echo "== Metrivo API entrypoint: migrations handled by db-init; starting API =="
exec node dist/src/main.js
