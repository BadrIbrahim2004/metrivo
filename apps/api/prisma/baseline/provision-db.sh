#!/bin/sh
# Runs INSIDE the postgres container (has psql).
# Provisions protected roles + baseline schema on a fresh database, mirroring
# apps/api/test/fixtures/postgres-init.sql + postgres-baseline.sql.
# Idempotent: safe to run repeatedly; never drops anything.
set -e

export PGHOST="${PGHOST:-db}"
CONN="-U ${POSTGRES_USER:?POSTGRES_USER required}"
# Provide the superuser password non-interactively
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"

OWNER_ROLE="metrivo_dev_owner"
MIGRATOR_ROLE="metrivo_dev_migrator"
APP_ROLE="metrivo"
APP_PASSWORD="${APP_PASSWORD:?APP_PASSWORD required}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD required}"

# Connection as the LOGIN migrator role (used to apply migrations via SET ROLE)
MIGRATOR_CONN="-U ${MIGRATOR_ROLE}"
export MIGRATOR_PASSWORD_ENV="$MIGRATOR_PASSWORD"

if ! psql $CONN -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${OWNER_ROLE}'" | grep -q 1; then
  psql $CONN -d postgres -c "CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
fi
if ! psql $CONN -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${MIGRATOR_ROLE}'" | grep -q 1; then
  SAFE_MIG_PW="$(printf '%s' "$MIGRATOR_PASSWORD" | sed "s/'/''/g")"
  psql $CONN -d postgres -c "CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${SAFE_MIG_PW}'"
fi
if ! psql $CONN -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}'" | grep -q 1; then
  # Password escaped for a single-quoted SQL literal
  SAFE_PW="$(printf '%s' "$APP_PASSWORD" | sed "s/'/''/g")"
  psql $CONN -d postgres -c "CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${SAFE_PW}'"
fi

psql $CONN -d postgres <<'SQL'
GRANT metrivo_dev_owner TO metrivo_dev_migrator;
SELECT 'CREATE DATABASE metrivo_prod OWNER metrivo_dev_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metrivo_prod') \gexec
ALTER DATABASE metrivo_prod OWNER TO metrivo_dev_owner;
SQL

psql $CONN -d metrivo_prod <<'SQL'
ALTER SCHEMA public OWNER TO metrivo_dev_owner;
GRANT CONNECT ON DATABASE metrivo_prod TO metrivo_dev_migrator;
GRANT CONNECT ON DATABASE metrivo_prod TO metrivo;
SQL

# Baseline schema applied AS the protected owner role (via migrator SET ROLE):
PGPASSWORD="$MIGRATOR_PASSWORD" psql $MIGRATOR_CONN -d metrivo_prod \
  -c "SET ROLE metrivo_dev_owner" \
  -f /workspace/prisma/baseline/baseline.sql

# App-role grants once all tables exist (owner executes the GRANTs):
PGPASSWORD="$MIGRATOR_PASSWORD" psql $MIGRATOR_CONN -d metrivo_prod \
  -c "SET ROLE metrivo_dev_owner;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO metrivo;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO metrivo;
      GRANT USAGE ON SCHEMA public TO metrivo;"

# --- Apply every Prisma migration as the protected owner role ---
# Same flow as apps/api/test/run-postgres-integration.cjs.
# Track each in _prisma_migrations so future `prisma migrate deploy` runs
# report up-to-date.
PGPASSWORD="$MIGRATOR_PASSWORD" psql $MIGRATOR_CONN -d metrivo_prod -c "SET ROLE metrivo_dev_owner;" -c \
  "CREATE TABLE IF NOT EXISTS \"_prisma_migrations\" (id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ(6), migration_name VARCHAR(255) NOT NULL UNIQUE, logs TEXT, rolled_back_at TIMESTAMPTZ(6), started_at TIMESTAMPTZ(6) NOT NULL, applied_steps_count INTEGER NOT NULL DEFAULT 0, name VARCHAR(255));" >/dev/null

for dir in /workspace/prisma/migrations/*/; do
  name="$(basename "$dir")"
  APPLIED="$(PGPASSWORD="$MIGRATOR_PASSWORD" psql $MIGRATOR_CONN -d metrivo_prod -tAc \
    "SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name='${name}' AND finished_at IS NOT NULL")" || APPLIED=""
  if [ "$APPLIED" = "1" ]; then
    echo "  skip ${name} (already applied)"
    continue
  fi
  echo "  applying migration ${name}"
  PGPASSWORD="$MIGRATOR_PASSWORD" psql $MIGRATOR_CONN -d metrivo_prod -v ON_ERROR_STOP=1 \
    -c "SET ROLE metrivo_dev_owner" -f "${dir}migration.sql"
  psql $CONN -d metrivo_prod -c \
    "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES (gen_random_uuid()::text, '', '${name}', now(), now(), 1)" >/dev/null
done

echo "provision-db.sh: done."
